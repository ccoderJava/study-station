.PHONY: build check tone tone-baseline serve open pack

# 构建站点（改完 content/ 下的 markdown 执行）
build:
	python3 build.py

# 只校验 front-matter、节点引用、id 重复、30 秒简述字数、语气配额
check:
	python3 build.py --check

# 列出语气欠账：哪篇、哪条规则、哪句话
tone:
	python3 build.py --tone

# 清掉一批语气问题后收紧基线（基线只准降）
tone-baseline:
	python3 build.py --tone-baseline

# 本地服务，localStorage 存进度比 file:// 稳定
serve:
	@echo "http://localhost:8787"
	@python3 -m http.server 8787

# 构建后直接用默认浏览器打开
open: build
	open index.html

# 打包成可拷进内网的 zip（产物在 dist/）
pack: build
	python3 pack.py
