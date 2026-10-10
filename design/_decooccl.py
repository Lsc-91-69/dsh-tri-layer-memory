# _decooccl.py — 差分全页基线图与「隐藏某装饰」图，找出被装饰压住的文字墨迹。
# 判据：隐藏装饰后变亮、且新亮度 > 120（文字级亮度；刻度线 #ffffff1f 叠底色只有 ~50，
#       方块 #353638 只有 ~54，分类竖条同刻度线级）→ 说明底下原本压着文字。
# 用 numpy 做整幅差分（纯 PIL 逐像素在 1270x9900 上要跑分钟级）。
# 用法: python _decooccl.py <tag> <width>
import json
import os
import sys
import numpy as np
from PIL import Image

D = r"D:\deepseek\deepseekh_work\plugins\dsh-tri-layer-memory\design"
OUT = os.path.join(D, "_headcheck-out")
tag, w = sys.argv[1], sys.argv[2]
meta = json.load(open(os.path.join(D, f"_decooccl-{tag}.json"), encoding="utf-8"))[w]
texts = meta["texts"]
names = ["grp-dot", "row-tick", "spine", "cat-bar", "caret"]
base = np.asarray(Image.open(os.path.join(OUT, f"deco-{tag}-{w}-base.png")).convert("RGB"), dtype=np.int16)
H, W, _ = base.shape
lum0 = base.mean(axis=2)


def who(x, y):
    for t in texts:
        if t["x"] - 2 <= x <= t["x"] + t["w"] + 2 and t["y"] - 2 <= y <= t["y"] + 22:
            return f'{t["tag"]}.{t["cls"]}「{t["t"]}」'
    return f"(x={x},y={y})"


print(f"[{tag}] width={w} 基线 {W}x{H}，文字元素 {len(texts)} 个")
for n in names:
    f = os.path.join(OUT, f"deco-{tag}-{w}-{n}.png")
    if not os.path.exists(f):
        print(f"  [{n}] 缺图")
        continue
    im = np.asarray(Image.open(f).convert("RGB"), dtype=np.int16)
    if im.shape != base.shape:
        print(f"  [{n}] 尺寸不一致 {im.shape} vs {base.shape}")
        continue
    lum1 = im.mean(axis=2)
    changed = int(np.any(im != base, axis=2).sum())
    mask = (lum1 > 120) & ((lum1 - lum0) > 20)
    ys, xs = np.nonzero(mask)
    hits = {}
    for x, y in zip(xs.tolist(), ys.tolist()):
        k = who(x, y)
        hits[k] = hits.get(k, 0) + 1
    verdict = "无文字被压" if len(xs) == 0 else f"⚠ 有文字被压：{len(hits)} 处"
    print(f"  [{n:9}] 差分={changed:>7}  露出文字级墨迹={len(xs):>5}  → {verdict}")
    for k, v in sorted(hits.items(), key=lambda kv: -kv[1])[:6]:
        print(f"        · {v:>4}px  {k}")
