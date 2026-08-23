.PHONY: all install build watch test typecheck package clean

all: build

node_modules: package.json package-lock.json
	npm install
	@touch node_modules

install: node_modules

build: node_modules
	npm run build

watch: node_modules
	npm run watch

test: node_modules
	npm test

typecheck: node_modules
	npx tsc --noEmit

package: node_modules
	npm run package

clean:
	rm -rf dist source-lm-*.zip
