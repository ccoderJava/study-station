.PHONY: build check serve open

# 构建站点（改完 content/ 下的 markdown 执行）
build:
	python3 build.py

# 只校验 front-matter、节点引用、id 重复
check:
	python3 build.py --check

# 本地服务，localStorage 存进度比 file:// 稳定
serve:
	@echo "http://localhost:8787"
	@python3 -m http.server 8787

# 构建后直接用默认浏览器打开
open: build
	open index.html
