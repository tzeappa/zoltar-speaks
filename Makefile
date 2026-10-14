# Zoltar Speaks. Run `make` for the list of targets.

NODE_MAJOR := 24

.DEFAULT_GOAL := help
.PHONY: help setup install node deps env services status dev start restart logs stop stop-ollama test check eval reset uninstall

help: ## Show this list
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  make %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: env install ## First run: create .env, install everything, start Ollama, pull models

install: node deps ## Install Node (if missing), npm packages, and Ollama
	@npm run --silent services -- --install

node: ## Check for Node 24+, install it with Homebrew if missing
	@if command -v node >/dev/null 2>&1; then \
	  major=$$(node -p 'process.versions.node.split(".")[0]'); \
	  if [ "$$major" -lt $(NODE_MAJOR) ]; then \
	    echo "  FAIL  Node $$(node -v) found; Node $(NODE_MAJOR)+ is required (built-in node:sqlite). Upgrade with brew, nvm, or fnm."; exit 1; \
	  fi; \
	  echo "  ok    Node $$(node -v)"; \
	elif [ "$$(uname)" = Darwin ] && command -v brew >/dev/null 2>&1; then \
	  echo "  ..    installing Node with Homebrew"; bash scripts/brew-install.sh node; \
	else \
	  echo "  FAIL  Node $(NODE_MAJOR)+ is required: https://nodejs.org/en/download"; exit 1; \
	fi

deps: node_modules/.package-lock.json ## Install npm packages

node_modules/.package-lock.json: package.json package-lock.json
	@echo "  ..    installing npm packages"
	@npm ci --no-audit --no-fund
	@echo "  ok    npm packages"

env: ## Create .env from .env.example if it does not exist
	@if [ -f .env ]; then echo "  ok    .env exists"; else cp .env.example .env && echo "  ok    created .env from .env.example"; fi

services: deps ## Start Ollama if it is down, pull missing models, load them into memory
	@npm run --silent services

status: deps ## Check Ollama, models, and the app's /healthz without changing anything
	@npm run --silent services -- --check
	@node --import tsx scripts/daemon.ts status

dev: services ## Start services, then the app with reload (http://localhost:8787)
	@npm run dev

start: deps ## Start services, then the app in the background (logs in data/zoltar.log)
	@node --import tsx scripts/daemon.ts running 2>/dev/null || npm run --silent services
	@node --import tsx scripts/daemon.ts start

restart: deps ## Stop the app, then start it again in the background
	@node --import tsx scripts/daemon.ts stop
	@$(MAKE) --no-print-directory start

logs: ## Follow the app's log (Control-C stops following, not the app)
	@mkdir -p data && touch data/zoltar.log
	@tail -n 50 -f data/zoltar.log

stop: ## Stop the app running from this folder (background, dev server, or Mac starter)
	@node --import tsx scripts/daemon.ts stop

stop-ollama: ## Stop the Ollama server started by `make services` (not the desktop app or brew services)
	@bash scripts/stop.sh --ollama-only

test: deps ## Typecheck and unit, integration, and security tests (mock model)
	@npm run --silent typecheck
	@npm test

check: test ## The test, smoke, and offline eval steps CI runs (plus shellcheck when installed)
	@if command -v shellcheck >/dev/null; then shellcheck scripts/*.sh install.sh *.command && echo "  ok    shellcheck"; fi
	@npm run --silent smoke
	@npm run --silent eval -- --mock
	@npm run --silent eval:retrieval -- --mock >/dev/null && echo "  ok    retrieval eval (offline)"

eval: services ## Accuracy, latency, and cost against the configured model
	@npm run --silent eval

reset: ## Delete the local database (stop the app first); the next start reseeds it
	@npm run --silent reset

uninstall: ## Remove what Zoltar installed (models, Ollama/Node it added, data, logs, .env); asks first
	@bash scripts/uninstall.sh
