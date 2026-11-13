# Cloudflare

Terraform config for the `joppekoers.nl` and `joppekoers.com` zones: DNS, zone settings, rulesets, tunnels (including ingress config) and Zero Trust.

Terraform and `cf-terraforming` run in the `cf-tools` container (see `Dockerfile`), wrapped by `run.sh`.

## Setup
```shell
cp cloudflare/.env-example cloudflare/.env # fill in API token and account ID
make tf-plan
```

## Changing things
```shell
make tf-plan
make tf-apply # applies, then re-encrypts the state into terraform.tfstate.gpg
```

The state contains secrets, so only `terraform.tfstate.gpg` is committed.

`imports.tf` maps every resource to its existing Cloudflare ID, so the state can be rebuilt from scratch with `terraform apply` if the encrypted state is ever lost.

## Exporting new resources
```shell
./cloudflare/run.sh cf-terraforming generate -z <zone_id> --resource-type cloudflare_dns_record --terraform-binary-path /bin/terraform
```
