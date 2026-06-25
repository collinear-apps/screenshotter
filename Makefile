# screenshotter — convenience task runner.
#
# The screenshotter CLI is the real interface; this Makefile is just shortcuts for
# common runs + living documentation of them. Override variables:
#   make full URL=https://example.com
#   make login URL=https://app.example.com        # save a session first
#   make full URL=https://app.example.com AUTH=.auth/app.json   # then capture authed
#   make full URL=https://huggingface.co SUBLINKS=1             # also follow sub-links (~150 pages)
#   make a11y-diff EXPECTED=golden.aria.yaml ACTUAL=http://localhost:3000
#
# (No `task`/extra tooling needed — plain make.)

URL       ?= https://huggingface.co
MODE      ?= web
THRESHOLD ?= 0.9
MAXMEM    ?= 8192
BUNDLE    ?= output/huggingface
AUTH      ?=
SUBLINKS  ?=

# Run node with extra heap headroom. Not strictly required (capture is memory-
# bounded by design), but a cheap safety net for very large sites.
NODE := NODE_OPTIONS=--max-old-space-size=$(MAXMEM) node

# Append `--auth <file>` to capture commands when AUTH is set (saved session).
AUTHFLAG := $(if $(AUTH),--auth $(AUTH))

# Append `--sub-links` when SUBLINKS is set: also follow + capture the links
# INSIDE each discovered page (default budget rises to ~150 pages).
SUBLINKSFLAG := $(if $(SUBLINKS),--sub-links)

.DEFAULT_GOAL := help
.PHONY: help install build typecheck capture mobile extract api full full-aggressive login add a11y-diff qc mock clean

help: ## Show available tasks
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install deps + the Chromium browser (one-time)
	npm install && npx playwright install chromium

build: ## Compile TypeScript -> dist/
	npm run build

typecheck: ## Type-check only (no emit)
	npm run typecheck

capture: build ## Screenshots + typography.md  (vars: URL, MODE, AUTH, SUBLINKS)
	$(NODE) dist/index.js $(URL) --mode $(MODE) $(AUTHFLAG) $(SUBLINKSFLAG)

mobile: build ## Capture in mobile (iPhone 13) mode  (vars: URL, AUTH, SUBLINKS)
	$(NODE) dist/index.js $(URL) --mode mobile $(AUTHFLAG) $(SUBLINKSFLAG)

extract: build ## + real assets, DOM, design tokens, a11y goldens  (vars: URL, AUTH, SUBLINKS)
	$(NODE) dist/index.js $(URL) --extract $(AUTHFLAG) $(SUBLINKSFLAG)

api: build ## + capture API specs: OpenAPI / catalog / HAR  (vars: URL, AUTH, SUBLINKS)
	$(NODE) dist/index.js $(URL) --api $(AUTHFLAG) $(SUBLINKSFLAG)

full: build ## Everything (safe): explore + extract + api  (vars: URL, AUTH, SUBLINKS)
	$(NODE) dist/index.js $(URL) --full --extract --api $(AUTHFLAG) $(SUBLINKSFLAG)

full-aggressive: build ## DANGEROUS: clicks/submits everything as the logged-in user (throwaway/staging only)  (vars: URL, AUTH, SUBLINKS)
	$(NODE) dist/index.js $(URL) --full --aggressive --extract --api $(AUTHFLAG) $(SUBLINKSFLAG)

login: build ## Interactive login -> saves a session for --auth  (var: URL)
	$(NODE) dist/index.js login $(URL)

add: build ## Append one URL to an existing bundle  (vars: URL, INTO, AUTH)
	$(NODE) dist/index.js add $(URL) $(if $(INTO),--into $(INTO)) $(AUTHFLAG)

a11y-diff: build ## Grade UI state  (vars: EXPECTED, ACTUAL, THRESHOLD)
	$(NODE) dist/index.js a11y-diff $(EXPECTED) $(ACTUAL) --threshold $(THRESHOLD)

qc: build ## Generate functional QC tasks; pass TARGET=<url> to run them  (vars: BUNDLE, TARGET)
	$(NODE) dist/index.js qc-tasks $(BUNDLE) $(if $(TARGET),--run --target $(TARGET))

verify: build ## Score a rebuild vs a captured bundle: pixel+a11y+functional  (vars: BUNDLE, TARGET, THRESHOLD)
	$(NODE) dist/index.js verify $(BUNDLE) $(TARGET) --threshold $(THRESHOLD)

mock: ## Run the generated mock API for a bundle  (var: BUNDLE)
	node $(BUNDLE)/web/api/mock/server.mjs

clean: ## Remove output/ and generated zips
	rm -rf output *-screenshots.zip
