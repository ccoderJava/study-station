#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
复习站构建器
------------
content/ 下的 markdown（带 YAML front-matter）→ 静态站点（index.html + assets/）

用法：
    python3 build.py            # 构建
    python3 build.py --check    # 只校验 front-matter，不生成

零第三方依赖，只用 Python 标准库。
"""
import os
import re
import json
import html
import sys
import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.join(BASE, "content")
THEME = os.path.join(BASE, "theme")
DIST = BASE
ASSETS = os.path.join(DIST, "assets")

TODAY = datetime.date.today().isoformat()


# ---------------------------------------------------------------- front-matter

def parse_front_matter(text):
    """解析 --- 包裹的 YAML 子集：key: value / key: "value" / key: [a, b]"""
    text = text.replace("\r\n", "\n")
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    block = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")
    meta = {}
    for line in block.split("\n"):
        if not line.strip() or line.strip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            meta[key] = [x.strip().strip('"').strip("'") for x in inner.split(",") if x.strip()]
        else:
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            meta[key] = val
    return meta, body


# ------------------------------------------------------------------- markdown

def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
    return s


def render_items(items):
    """items: [(indent, marker, text)] → 支持嵌套的 ul/ol"""
    res, stack = [], []
    for ind, marker, text in items:
        tag = "ol" if re.match(r"^\d", marker) else "ul"
        while stack and ind < stack[-1][0]:
            res.append("</%s>" % stack.pop()[1])
        if not stack or ind > stack[-1][0]:
            res.append("<%s>" % tag)
            stack.append((ind, tag))
        elif stack[-1][1] != tag:
            res.append("</%s><%s>" % (stack.pop()[1], tag))
            stack.append((ind, tag))
        res.append("<li>%s</li>" % inline(text))
    while stack:
        res.append("</%s>" % stack.pop()[1])
    return "".join(res)


def render_table(rows):
    cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
    sep = None
    if len(cells) >= 2 and all(re.match(r"^:?-{1,}:?$", c.replace(" ", "")) for c in cells[1]):
        sep = cells[1]
        body = [cells[0]] + cells[2:]
    else:
        body = cells
    aligns = []
    if sep:
        for c in sep:
            c = c.replace(" ", "")
            if c.startswith(":") and c.endswith(":"):
                aligns.append("center")
            elif c.endswith(":"):
                aligns.append("right")
            else:
                aligns.append("left")
    out = ["<div class='tw'><table>"]
    for ri, row in enumerate(body):
        tag = "th" if ri == 0 and sep else "td"
        tds = []
        for ci, c in enumerate(row):
            al = aligns[ci] if ci < len(aligns) else "left"
            style = " style='text-align:%s'" % al if al != "left" else ""
            tds.append("<%s%s>%s</%s>" % (tag, style, inline(c), tag))
        out.append("<tr>" + "".join(tds) + "</tr>")
    out.append("</table></div>")
    return "".join(out)


def md_to_html(md, hid_prefix=None):
    """返回 (html, toc)。hid_prefix 非空时给标题加 id，并收集目录项。"""
    lines = md.replace("\r\n", "\n").split("\n")
    out, i, n = [], 0, len(lines)
    toc = []
    while i < n:
        line = lines[i]
        s = line.strip()
        if not s:
            i += 1
            continue

        if s.startswith("```"):
            lang = s[3:].strip()
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(html.escape(lines[i]))
                i += 1
            i += 1
            cls = " class='lang-%s'" % lang if lang else ""
            out.append("<pre><code%s>%s</code></pre>" % (cls, "\n".join(buf)))
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            lvl = len(m.group(1))
            raw = m.group(2)
            hid = ""
            if hid_prefix:
                hid = ' id="%s%d"' % (hid_prefix, len(toc) + 1)
                plain = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", raw)
                plain = re.sub(r"[*`]", "", plain).strip()
                toc.append({"id": "%s%d" % (hid_prefix, len(toc) + 1), "t": plain, "lv": lvl})
            out.append("<h%d%s>%s</h%d>" % (lvl, hid, inline(raw), lvl))
            i += 1
            continue

        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", s):
            out.append("<hr/>")
            i += 1
            continue

        if s.startswith("|"):
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(lines[i].strip())
                i += 1
            out.append(render_table(rows))
            continue

        if s.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(inline(lines[i].strip()[1:].strip()))
                i += 1
            out.append("<blockquote>" + "<br/>".join(buf) + "</blockquote>")
            continue

        if re.match(r"^\s*([-*+]|\d+[.)])\s+", line):
            items = []
            while i < n and re.match(r"^\s*([-*+]|\d+[.)])\s+", lines[i]):
                mm = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", lines[i])
                items.append((len(mm.group(1)), mm.group(2), mm.group(3)))
                i += 1
            out.append(render_items(items))
            continue

        buf = []
        while i < n:
            cs = lines[i].strip()
            if not cs:
                break
            if re.match(r"^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```)", cs):
                break
            if re.match(r"^(-{3,}|\*{3,}|_{3,})$", cs):
                break
            buf.append(cs)
            i += 1
        if buf:
            text = ""
            for k, raw in enumerate(buf):
                if k and re.search(r"[A-Za-z0-9]$", buf[k - 1]) and re.match(r"^[A-Za-z0-9]", raw):
                    text += " "
                text += inline(raw)
            out.append("<p>" + text + "</p>")
    return "\n".join(out), toc


def excerpt(md, limit=72):
    for ln in md.split("\n"):
        s = ln.strip()
        if not s or s.startswith("#") or s.startswith(">") or s.startswith("|") or s.startswith("---"):
            continue
        s = re.sub(r"[*`>]", "", s)
        s = re.sub(r"^\s*[-*+]\s+", "", s)
        return s[:limit] + ("…" if len(s) > limit else "")
    return ""


# ------------------------------------------------------------------- 加载内容

def load_dir(sub):
    d = os.path.join(CONTENT, sub)
    if not os.path.isdir(d):
        return []
    result = []
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".md"):
            continue
        raw = open(os.path.join(d, fn), encoding="utf-8").read()
        meta, body = parse_front_matter(raw)
        meta["_file"] = "%s/%s" % (sub, fn)
        meta["_body"] = body
        result.append(meta)
    return result


def build_data():
    layers = load_dir("layers")
    nodes = load_dir("nodes")
    cards = load_dir("cards")
    scenarios = load_dir("scenarios")

    layers.sort(key=lambda x: int(x.get("order", 99)))
    nodes.sort(key=lambda x: x.get("id", ""))
    items = cards + scenarios

    problems = []

    def need(obj, keys, label):
        for k in keys:
            if not obj.get(k):
                problems.append("%s 缺少字段 %s" % (label, k))

    for L in layers:
        need(L, ["id", "name"], "layer:%s" % L["_file"])
    for N in nodes:
        need(N, ["id", "layer", "name"], "node:%s" % N["_file"])
    for C in items:
        need(C, ["id", "title", "kind", "nodes"], "item:%s" % C["_file"])
        if isinstance(C["nodes"], str):
            C["nodes"] = [x.strip() for x in C["nodes"].split(",") if x.strip()]

    node_ids = {n["id"] for n in nodes}
    layer_ids = {l["id"] for l in layers}
    for N in nodes:
        if N["layer"] not in layer_ids:
            problems.append("node %s 的 layer %s 不存在" % (N["id"], N["layer"]))
    for C in items:
        for t in C["nodes"]:
            if t not in node_ids:
                problems.append("item %s 引用了不存在的知识点 %s" % (C["id"], t))

    ids = [c["id"] for c in items]
    dup = {x for x in ids if ids.count(x) > 1}
    if dup:
        problems.append("重复的 id: %s" % ", ".join(sorted(dup)))

    for C in items:
        C["_html"], C["_toc"] = md_to_html(C["_body"], "s")
        C["_excerpt"] = excerpt(C["_body"])
        C["level"] = C.get("level", "normal")
        C["status"] = C.get("status", "draft")
    for N in nodes:
        N["_html"], _ = md_to_html(N["_body"])
        N["_excerpt"] = excerpt(N["_body"])

    for N in nodes:
        N["cards"] = [c["id"] for c in cards if N["id"] in c["nodes"]]
        N["scenarios"] = [c["id"] for c in scenarios if N["id"] in c["nodes"]]

    data = {
        "generated": TODAY,
        "layers": [{"id": l["id"], "name": l["name"], "role": l.get("role", ""),
                    "desc": l.get("desc", ""), "order": int(l.get("order", 99))} for l in layers],
        "nodes": [{"id": n["id"], "layer": n["layer"], "name": n["name"],
                   "keywords": n.get("keywords", []), "html": n["_html"],
                   "excerpt": n["_excerpt"], "cards": n["cards"],
                   "scenarios": n["scenarios"]} for n in nodes],
        "items": [{"id": c["id"], "kind": c["kind"], "title": c["title"],
                   "nodes": c["nodes"], "primary": c.get("primary", c["nodes"][0] if c["nodes"] else ""),
                   "direction": c.get("direction", "未分类"), "event": c.get("event", "未分类"),
                   "project": c.get("project", ""), "level": c["level"],
                   "status": c["status"], "created": c.get("created", ""),
                   "updated": c.get("updated", ""), "html": c["_html"],
                   "toc": c["_toc"], "excerpt": c["_excerpt"]} for c in items],
    }
    return data, problems


# ------------------------------------------------------------------- 生成站点

def write_site(data):
    os.makedirs(ASSETS, exist_ok=True)
    tpl_index = open(os.path.join(THEME, "index.html"), encoding="utf-8").read()
    open(os.path.join(DIST, "index.html"), "w", encoding="utf-8").write(tpl_index)

    for name in ("app.js", "style.css"):
        src = os.path.join(THEME, name)
        if os.path.exists(src):
            open(os.path.join(ASSETS, name), "w", encoding="utf-8").write(
                open(src, encoding="utf-8").read())

    payload = "window.KB=" + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";"
    open(os.path.join(ASSETS, "data.js"), "w", encoding="utf-8").write(payload)
    return len(payload)


def main():
    data, problems = build_data()
    if "--check" in sys.argv:
        if problems:
            print("⚠ 内容校验发现 %d 个问题：" % len(problems))
            for p in problems:
                print("   -", p)
            return 1
        print("校验通过：%d 个层 / %d 个知识点 / %d 篇内容" % (
            len(data["layers"]), len(data["nodes"]), len(data["items"])))
        return 0

    if problems:
        print("⚠ 内容校验发现 %d 个问题：" % len(problems))
        for p in problems:
            print("   -", p)

    size = write_site(data)
    n_nodes = len(data["nodes"])
    cov = len([n for n in data["nodes"] if n["cards"] or n["scenarios"]])
    n_cards = len([c for c in data["items"] if c["kind"] == "card"])
    n_sc = len([c for c in data["items"] if c["kind"] == "scenario"])
    print("构建完成")
    print("  知识点 %d 个（已覆盖 %d，%.0f%%）" % (n_nodes, cov, cov * 100.0 / max(n_nodes, 1)))
    print("  卡片 %d 篇，场景题 %d 道" % (n_cards, n_sc))
    print("  数据 %.0f KB → assets/data.js" % (size / 1024.0))
    print("  入口 %s" % os.path.join(DIST, "index.html"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
