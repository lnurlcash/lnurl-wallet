.PHONY: all format lint check test install install-precommit dev build

all: format lint

format:
	npm run format

lint: format tsc

tsc:
	npm run tsc

check:
	npm run format:check

test:
	npm test

install:
	npm install

# Wires up .pre-commit-config.yaml's git hooks (format+tsc on commit, the
# full test suite - wallet and src/lib's own isolated check - on push).
# Installs the pre-commit framework itself first if it isn't already on
# PATH, preferring pipx (keeps it out of any project's own venv/deps).
install-precommit:
	command -v pre-commit >/dev/null 2>&1 || \
		(command -v pipx >/dev/null 2>&1 && pipx install pre-commit) || \
		pip install --user pre-commit
	pre-commit install
	pre-commit install --hook-type pre-push

dev:
	npm run dev

build:
	npm run build
