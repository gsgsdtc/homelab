IMAGE_NAME ?= homelab:local
ENV_FILE ?= apps/backend/.env
PORT ?= 3000
OPS_DEPLOY ?= ./deploy.sh

.PHONY: help image-build image-run deploy-image check-release-version ops-deploy ops-deploy-check

help:
	@echo "Targets:"
	@echo "  make image-build                         Build the local Docker image"
	@echo "  make image-run                           Run the local Docker image"
	@echo "  make deploy-image VERSION=v1.2.3         Push a release tag that publishes the image"
	@echo "  make ops-deploy-check                    Validate local deployment prerequisites"
	@echo "  make ops-deploy                          Deploy backend/admin/portal locally"

image-build:
	docker build -f deploy/Dockerfile -t $(IMAGE_NAME) .

image-run:
	docker run --env-file $(ENV_FILE) -p $(PORT):$(PORT) $(IMAGE_NAME)

check-release-version:
	@if [ -z "$(VERSION)" ]; then \
		echo "VERSION is required. Example: make deploy-image VERSION=v1.2.3"; \
		exit 1; \
	fi
	@case "$(VERSION)" in \
		v*.*.*) ;; \
		*) echo "VERSION must match v*.*.*, for example v1.2.3"; exit 1 ;; \
	esac
	@if git rev-parse -q --verify "refs/tags/$(VERSION)" >/dev/null; then \
		echo "Tag $(VERSION) already exists locally"; \
		exit 1; \
	fi
	@git diff --quiet || { echo "Working tree has unstaged changes; commit or stash them before deploying"; exit 1; }
	@git diff --cached --quiet || { echo "Index has staged changes; commit or unstage them before deploying"; exit 1; }

deploy-image: check-release-version
	git tag $(VERSION)
	git push origin $(VERSION)
	@echo "Pushed $(VERSION). GitHub Actions will publish ghcr.io/<owner>/<repo>:$(VERSION) and :latest."

ops-deploy-check:
	$(OPS_DEPLOY) --check-only

ops-deploy:
	$(OPS_DEPLOY)
