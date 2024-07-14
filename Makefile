export CAROOT ?= $(shell cd scripts; go run filippo.io/mkcert -CAROOT)

.PHONY: pub-moq pub-dash

dev: certs/localhost.crt
	@docker compose stop
	@docker compose rm -fsv
	@docker container prune -f
	@docker compose --profile dev up --build --remove-orphans --renew-anon-volumes

prod: certs/localhost.crt
	@docker compose stop
	@docker compose rm -fsv
	@docker container prune -f
	@docker compose --profile prod up --build --remove-orphans --renew-anon-volumes

pub-moq:
	@scripts/pub-moq.sh --docker 1 --testsrc 1

pub-dash:
	@scripts/pub-dash.sh --testsrc 1

certs/localhost.crt:
	@git submodule update --init --recursive
	@scripts/cert
	@mkdir -p certs
	@mv scripts/localhost.* certs/
