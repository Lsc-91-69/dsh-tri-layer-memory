/**
 * test/retrieval.test.mjs — 检索质量三项改动的行为测试（3a 停用词 / 3b IDF / 3c digest 降权）。
 *
 * 为什么单独成文件：这三项改的是**生产检索**（`searchRecords` → `DeepMemoryStore.search`），
 * 一旦悄悄退化，变现方式很隐蔽——召回还是"有结果"，只是排在最前的是错的那条。
 * 所以这里只断言可观察的排序性质，不碰内部字段：
 *   1. 疑问词（按二元组）不再把无关记录拉上来；
 *   2. 稀有词的权重高于"全库都含"的词；
 *   3. 同分时仍是 createdAt 降序（确定性）；
 *   4. digest 在得分相同时让位给具体 turn；
 *   5. 生产路径（store 里带 df 缓存）与纯函数路径（现算 df）结果逐条一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BASE_STOPWORDS,
  DeepMemoryStore,
  QUESTION_STOPWORDS,
  STOPWORDS,
  buildDocFreq,
  extractKeywords,
  searchRecords,
} from '../src/host/l3-deep.ts'

/** 造一条记录（字段补齐，避免每个用例重复写）。 */
function rec(over = {}) {
  const text = over.text ?? ''
  return {
    id: over.id ?? 'r',
    kind: over.kind ?? 'turn',
    createdAt: over.createdAt ?? 1_700_000_000_000,
    sessionId: over.sessionId ?? 's1',
    turnFrom: over.turnFrom ?? 1,
    turnTo: over.turnTo ?? 1,
    text,
    tokens: 10,
    keywords: over.keywords ?? extractKeywords(text),
    refs: [],
  }
}

// ── 3a：疑问词必须按二元组过滤 ────────────────────────────────────────────

test('extractKeywords：疑问词按二元组被过滤，不会再靠「为什/什么」把无关长文拉上来', () => {
  // 这一条是本次改动的**关键事实**：「为什么」在「为什么预设会消失」里切出来的是
  // 为什 + 什么，整词「为什么」根本不会成为 token。只加原词等于没加。
  const tokens = extractKeywords('为什么预设会消失')
  assert.ok(!tokens.includes('为什'), '「为什」必须被过滤（它是「为什么」的二元组）')
  assert.ok(!tokens.includes('什么'), '「什么」必须被过滤')
  assert.ok(tokens.includes('预设'), '实词不能被误伤')
  assert.ok(tokens.includes('消失'), '实词不能被误伤')

  // 带空格分隔的短段会被额外整段成一个 token，所以整词形式也要在停用词里。
  const spaced = extractKeywords('为什么 readEvents 读不到会话事件')
  assert.ok(!spaced.includes('为什么'))
  assert.ok(spaced.includes('readevents'))

  // 停用词表本身就是"基础虚词 + 疑问词"，别把它们合成一份导致以后想拆都拆不开。
  for (const word of ['什么', '怎么', '为什', '如何', '是否', '哪个', '哪里', '多少', '可以', '需要', '应该', '哪些', '怎样']) {
    assert.ok(QUESTION_STOPWORDS.has(word), `${word} 应在疑问词表里`)
    assert.ok(STOPWORDS.has(word), `${word} 应合并进生产停用词`)
    assert.ok(!BASE_STOPWORDS.has(word), `${word} 不应混进基础停用词（要保持可单独开关）`)
  }
})

test('extractKeywords：可以传入别的停用词集合（消融用，不改默认行为）', () => {
  const withDefault = extractKeywords('为什么预设会消失')
  const withBase = extractKeywords('为什么预设会消失', 24, BASE_STOPWORDS)
  assert.ok(!withDefault.includes('为什'))
  assert.ok(withBase.includes('为什'), '换回旧表应重新出现「为什」——这正是 3a 的对照口径')
})

// ── 3b：IDF ─────────────────────────────────────────────────────────────

test('buildDocFreq：df 是「含该词的记录数」，没出现过的词计 0', () => {
  const records = [
    rec({ id: 'a', text: 'esbuild 报错' }),
    rec({ id: 'b', text: '插件 列表' }),
    rec({ id: 'c', text: '插件 报错' }),
  ]
  const { n, df } = buildDocFreq(records, ['esbuild', '插件', '不存在的词'])
  assert.equal(n, 3)
  assert.equal(df.get('esbuild'), 1)
  assert.equal(df.get('插件'), 2)
  assert.equal(df.get('不存在的词'), 0)
})

test('searchRecords：稀有词的权重高于全库都含的词（IDF 生效）', () => {
  // 20 条都在讲「插件」，只有 1 条讲 esbuild。查询同时含两个词时，
  // 等权计数会让它们并列（再由 createdAt 决定），IDF 应让稀有词那条排第一。
  const records = [
    ...Array.from({ length: 20 }, (_, i) => rec({ id: `common${i}`, text: `插件 说明 ${i}`, createdAt: 1_700_000_000_000 + i })),
    rec({ id: 'rare', text: 'esbuild 缺失', createdAt: 1_700_000_000_000 }),
  ]
  const ranked = searchRecords(records, 'esbuild 插件', 3)
  assert.equal(ranked[0].id, 'rare', '稀有词匹配的记录应排在只匹配常见词的前面')

  // 关掉 IDF 就退回等权：新近度（createdAt 降序）重新主导 → rare 不是第一。
  const equalWeight = searchRecords(records, 'esbuild 插件', 3, { idf: false })
  assert.notEqual(equalWeight[0].id, 'rare')
})

test('searchRecords：命中的词若在全库都出现（IDF=0），记录仍必须被返回', () => {
  // 这是个真实回归风险：改成按 score>0 过滤的话，全库都含的词权重为 0，
  // "确实命中了"的记录会被误判成没命中，整条召回直接消失。
  const records = Array.from({ length: 5 }, (_, i) => rec({ id: `r${i}`, text: `全部 记录 ${i}` }))
  const hits = searchRecords(records, '全部', 10)
  assert.equal(hits.length, 5, '权重为 0 不等于没命中')
})

// ── 3c：digest 降权 ─────────────────────────────────────────────────────

test('searchRecords：得分相同时具体 turn 排到 digest 前面；关掉降权后按新近度', () => {
  const text = 'esbuild 找不到时的修法'
  const oldTurn = rec({ id: 'turn', kind: 'turn', text, createdAt: 1_700_000_000_000 })
  // digest 更新：不降权时它会因为"更新"排在前面（旧行为的平局规则）。
  const newDigest = rec({ id: 'digest', kind: 'digest', text, createdAt: 1_700_000_100_000 })
  // 必须有"不含查询词"的记录，否则 df == n，所有词的 IDF 都是 log(1)=0，
  // 得分全为 0，排序会退回新近度——那样测的就不是降权系数了。
  const decoys = Array.from({ length: 6 }, (_, i) => rec({ id: `decoy${i}`, text: `园艺 盆栽 ${i}` }))
  const records = [oldTurn, newDigest, ...decoys]

  assert.equal(searchRecords(records, 'esbuild 修法', 2)[0].id, 'turn', 'digest 降权后具体记录应排第一')
  const noWeight = searchRecords(records, 'esbuild 修法', 2, { digestWeight: 1 })
  assert.equal(noWeight[0].id, 'digest', '系数 1 时回到旧行为（同分 → 新近度降序）')
})

// ── 确定性 ──────────────────────────────────────────────────────────────

test('searchRecords：平局按 createdAt 降序，结果与输入顺序无关', () => {
  const text = '同分 记录'
  const newer = rec({ id: 'newer', text, createdAt: 2_000 })
  const older = rec({ id: 'older', text, createdAt: 1_000 })
  assert.deepEqual(searchRecords([older, newer], '同分', 2).map((r) => r.id), ['newer', 'older'])
  assert.deepEqual(searchRecords([newer, older], '同分', 2).map((r) => r.id), ['newer', 'older'])
})

// ── 生产路径 = 纯函数路径（df 缓存不许改变结果）──────────────────────────

test('DeepMemoryStore.search 与 searchRecords(全库) 逐条一致，且 put/prune 后仍一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-retrieval-'))
  const store = new DeepMemoryStore(dir, 'jsonl')
  return store.open().then(() => {
    try {
      store.put({ kind: 'turn', sessionId: 's1', turnFrom: 1, turnTo: 1, text: 'esbuild 缺失导致构建失败', createdAt: 1_700_000_000_000 })
      store.put({ kind: 'digest', sessionId: 's1', turnFrom: 1, turnTo: 9, text: 'esbuild 构建链路排查，顺带修了插件列表', createdAt: 1_700_000_500_000 })
      store.put({ kind: 'turn', sessionId: 's1', turnFrom: 2, turnTo: 2, text: '插件 列表被截断时怎么办', createdAt: 1_700_000_900_000 })
      const queries = ['esbuild 找不到时怎么修？', '插件 列表 怎么截断', '为什么预设会消失']

      const compare = (label) => {
        for (const query of queries) {
          const fromStore = store.search(query, 5).map((r) => r.id)
          const fromPure = searchRecords(store.all(), query, 5).map((r) => r.id)
          assert.deepEqual(fromStore, fromPure, `${label}：${query} 的生产路径与纯函数路径必须一致`)
        }
      }
      // 首次：df 缓存从空开始建
      compare('新建')
      // 再跑一次：命中 df 缓存（走缓存分支，结果不许变）
      compare('缓存命中')
      // 记录变动后：df 缓存必须失效，否则会拿旧分母算 IDF
      store.put({ kind: 'turn', sessionId: 's2', turnFrom: 3, turnTo: 3, text: 'esbuild 又一次缺失', createdAt: 1_700_001_000_000 })
      compare('put 之后')
      store.prune(['esbuild'], 0, 2, 1_700_002_000_000)
      compare('prune 之后')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
