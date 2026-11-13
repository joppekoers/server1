resource "cloudflare_zero_trust_organization" "this" {
  account_id                                  = var.account_id
  name                                        = "morfield.cloudflareaccess.com"
  auth_domain                                 = "morfield.cloudflareaccess.com"
  deny_unmatched_requests                     = false
  deny_unmatched_requests_exempted_zone_names = []

  # The API omits action and inactivity_threshold_days while disabled, but the provider requires them when set.
  lifecycle {
    ignore_changes = [service_token_inactivity]
  }
}

resource "cloudflare_zero_trust_access_identity_provider" "one_time_pin" {
  account_id = var.account_id
  name       = ""
  type       = "onetimepin"
  config     = {}
}
