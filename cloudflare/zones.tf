resource "cloudflare_zone" "nl" {
  name    = "joppekoers.nl"
  account = { id = var.account_id }
}

resource "cloudflare_zone" "com" {
  name    = "joppekoers.com"
  account = { id = var.account_id }
}

resource "cloudflare_zone_dnssec" "nl" {
  zone_id = cloudflare_zone.nl.id
  status  = "disabled"
}

resource "cloudflare_zone_dnssec" "com" {
  zone_id = cloudflare_zone.com.id
  status  = "disabled"
}
