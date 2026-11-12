#!/usr/bin/env python3
"""把站点打包成一个可以拷进内网的 zip。

用法：
    python3 pack.py           # 打包到 dist/knowledge-workbench.zip
    python3 pack.py --date    # 文件名带日期，便于留多个版本

打包内容为全量（页面 + 内容源文件 + 构建脚本），内网既能直接阅读，
有 Python 时也能继续写卡片。排除 .git、.workbuddy、__pycache__。

中文文件名统一写 UTF-8 标记，Windows 资源管理器解压不会乱码。
"""

import os
import sys
import time
import zipfile

ROOT_NAME = "knowledge-workbench"
OUT_DIR = "dist"
SKIP_DIRS = {".git", ".workbuddy", "__pycache__", ".idea", ".vscode", "dist"}
SKIP_FILES = {".DS_Store"}


def collect(root):
    """返回 [(绝对路径, zip 内相对路径)]，保持目录结构。"""
    items = []
    for cur, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for fn in sorted(files):
            if fn in SKIP_FILES:
                continue
            path = os.path.join(cur, fn)
            rel = os.path.relpath(path, root)
            items.append((path, os.path.join(ROOT_NAME, rel)))
    return items


def main():
    out_name = ROOT_NAME + (time.strftime("-%Y%m%d") if "--date" in sys.argv else "") + ".zip"
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, out_name)

    items = collect(".")
    if not items:
        print("× 当前目录没有可打包的文件，请在项目根目录执行")
        return 1

    # 产物是否最新：改了 content/ 却没构建的话，内网看到的是旧内容
    stale = []
    for target, dep in [("index.html", "content"), ("assets/data.js", "content")]:
        if not os.path.exists(target):
            stale.append(target + " 不存在")
            continue
        mt = os.path.getmtime(target)
        for cur, _dirs, files in os.walk(dep):
            for fn in files:
                if os.path.getmtime(os.path.join(cur, fn)) > mt:
                    stale.append("有比 " + target + " 更新的源文件")
                    break
            else:
                continue
            break
    if stale:
        print("! 构建产物可能过期，建议先跑 python3 build.py")
        for s in set(stale):
            print("  -", s)
        print()

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path, arc in items:
            z.write(path, arc)

    size = os.path.getsize(out)
    print("已生成 %s（%d 个文件，%.0f KB）" % (out, len(items), size / 1024))
    print()
    print("内网使用：")
    print("  1. 解压后双击 %s/index.html（用 Chrome 或 Edge，不支持 IE11）" % ROOT_NAME)
    print("  2. 学习进度不会跟着文件走，先在本机「数据 → 下载 .json」，内网再导入")
    return 0


if __name__ == "__main__":
    sys.exit(main())
