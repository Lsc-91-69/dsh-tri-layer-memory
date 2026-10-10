# _occlpix.py — 差分 <tag>-on-<w>.png 与 <tag>-off-<w>.png。
# 判定：隐藏 .dot 后，**除了刻度线本身**，是否还有像素变亮（= 被方块吃掉的文字墨迹）。
# 关键区分：
#   · 方块本体 #353638 比底色 #151517 亮，隐藏后该处会变暗 → 不计入。
#   · 方块外圈 box-shadow 是底色 #151517 不透明环，隐藏后环下若是刻度线
#     （--border-l2 叠在底色上，更亮）会变亮 → 这是刻度线复现，不是文字。
#   · 环下若是文字墨迹（--label-secondary #cfd3d6，很亮）→ 大幅变亮 → 这才是遮挡。
# 因此按「变亮像素相对方块中心的水平偏移」分桶：落在刻度线列（±3px）的算刻度线，其余算文字。
import json
import os
import sys
from PIL import Image

D = r"D:\deepseek\deepseekh_work\plugins\dsh-tri-layer-memory\design"
OUT = os.path.join(D, "_headcheck-out")
tag = sys.argv[1]
w = sys.argv[2]

a = Image.open(os.path.join(OUT, f"{tag}-on-{w}.png")).convert("RGB")
b = Image.open(os.path.join(OUT, f"{tag}-off-{w}.png")).convert("RGB")
assert a.size == b.size, f"size mismatch {a.size} vs {b.size}"
pa, pb = a.load(), b.load()
W, H = a.size
meta = json.load(open(os.path.join(D, f"_occlpix-{tag}.json"), encoding="utf-8"))[w]
clip_y = meta["clip"]["y"]
heads = meta["heads"]

# 方块中心 x（用实测：差分像素的 x 直方图里最宽的那一列簇就是方块本体）
col = {}
rows = {}
for y in range(H):
    for x in range(W):
        if pa[x, y] != pb[x, y]:
            col[x] = col.get(x, 0) + 1
            rows[y] = rows.get(y, 0) + 1
if not col:
    print(f"[{tag}] width={w} 两次截图完全一致 → 该元素不遮挡任何像素")
    sys.exit(0)

# 逐组头统计
buckets = {}
for i, h in enumerate(heads):
    buckets[i] = {"n": 0, "bright": 0, "bright_on_spine": 0, "bright_off_spine": 0, "xs": [], "label": h["label"]}
for y in range(H):
    for x in range(W):
        ca, cb = pa[x, y], pb[x, y]
        if ca == cb:
            continue
        py = y + clip_y
        for i, h in enumerate(heads):
            if h["top"] - 8 <= py <= h["top"] + h["h"] + 8:
                d = buckets[i]
                d["n"] += 1
                if sum(cb) / 3 - sum(ca) / 3 > 20:
                    d["bright"] += 1
                    d["xs"].append(x)
                break

# 刻度线列 = 该组头变亮像素里出现次数最多的那一列（方块钉在刻度线上，中心即刻度线）
print(f"[{tag}] width={w} 图 {W}x{H}  差分像素={sum(col.values())}  列范围={min(col)}..{max(col)}")
total_off = 0
for i in range(len(heads)):
    d = buckets[i]
    if not d["xs"]:
        print(f"  组头[{i:2}] {d['label']:<24} 差分={d['n']:>4} 变亮=0")
        continue
    from collections import Counter
    c = Counter(d["xs"])
    spine = c.most_common(1)[0][0]
    off = [x for x in d["xs"] if abs(x - spine) > 3]
    total_off += len(off)
    print(f"  组头[{i:2}] {d['label']:<24} 差分={d['n']:>4} 变亮={d['bright']:>3}（刻度线列x={spine}: {d['bright']-len(off):>3}，离列: {len(off):>3}）离列x={sorted(set(off)) if off else '-'}")
print(f"[{tag}] width={w} 结论: 落在刻度线之外的『变亮』像素 = {total_off}（>0 说明方块吃掉了文字墨迹）")
