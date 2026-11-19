resource "cloudflare_dns_record" "nl_shop_acme_challenge" {
  zone_id = cloudflare_zone.nl.id
  name    = "_acme-challenge.shop.joppekoers.nl"
  type    = "CNAME"
  content = "shop.joppekoers.nl.f6f28bc55d1e198c.dcv.cloudflare.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_dev" {
  zone_id = cloudflare_zone.nl.id
  name    = "dev.joppekoers.nl"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.dev_nl.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_wildcard" {
  zone_id = cloudflare_zone.nl.id
  name    = "*.joppekoers.nl"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.server1.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_apex" {
  zone_id = cloudflare_zone.nl.id
  name    = "joppekoers.nl"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.server1.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_lucas" {
  zone_id = cloudflare_zone.nl.id
  name    = "lucas.joppekoers.nl"
  type    = "CNAME"
  content = "shop.celebratix.io"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_offsite" {
  zone_id = cloudflare_zone.nl.id
  name    = "offsite.joppekoers.nl"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.offsite.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_shop" {
  zone_id = cloudflare_zone.nl.id
  name    = "shop.joppekoers.nl"
  type    = "CNAME"
  content = "shop-proxy.celebratix.io"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_ssh" {
  zone_id = cloudflare_zone.nl.id
  name    = "ssh.joppekoers.nl"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.server1.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_stormtrooper_backup" {
  zone_id = cloudflare_zone.nl.id
  name    = "stormtrooper-backup.joppekoers.nl"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.stormtrooper_backup.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_terra" {
  zone_id = cloudflare_zone.nl.id
  name    = "terra.joppekoers.nl"
  type    = "CNAME"
  content = "bc19a07b-5b23-4f45-8c76-f2589df0bccf.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_mx01" {
  zone_id  = cloudflare_zone.nl.id
  name     = "joppekoers.nl"
  type     = "MX"
  content  = "mx01.mail.icloud.com"
  priority = 10
  proxied  = false
  ttl      = 1
}

resource "cloudflare_dns_record" "nl_mx02" {
  zone_id  = cloudflare_zone.nl.id
  name     = "joppekoers.nl"
  type     = "MX"
  content  = "mx02.mail.icloud.com"
  priority = 10
  proxied  = false
  ttl      = 1
}

resource "cloudflare_dns_record" "nl_acme_challenge" {
  zone_id = cloudflare_zone.nl.id
  name    = "_acme-challenge.joppekoers.nl"
  type    = "TXT"
  content = "\"XPZRIoSQA5ySolBDRoOlahO5lpFYhi6ke-QYW6Kfa6A\""
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_discord" {
  zone_id = cloudflare_zone.nl.id
  name    = "_discord.joppekoers.nl"
  type    = "TXT"
  content = "dh=b5eb7c5c2f71ed1d0be0cdc0f82e35253c8fdb8a"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_google_dkim" {
  zone_id = cloudflare_zone.nl.id
  name    = "google._domainkey.joppekoers.nl"
  type    = "TXT"
  content = "\"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6VUsiV3DhYVstHUoE4nOxRGUp9rbtVI/TL6oPnw+H8X8PB+VTwHBANu4ut2/12Rbxm7GvPcdczRaf4DSRBh7SEl/iq16TPpba9pWCky2EuoXaWqN6YSPy3rdpitqbjz4tPH1U5kWlSa+ePv5rYEo5xqymDaNewXerYfVf1YUFOZdqNE++EWPrqCFU/hCTqMcC\" \"qYdrtow4CsQyNHTOKsJdWH+UTh585jNzpH1r6QtV9bLV7KL+YULs1Ig1zdH7rr62I5M3//GBxkEG3l5os7mufAwGs829uRhsZJOpYU7IE4ReKmkPg5SeY6S5Y1DpkKvlqZh8JoAJyOsAt5l6xcvHwIDAQAB\""
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_spf" {
  zone_id = cloudflare_zone.nl.id
  name    = "joppekoers.nl"
  type    = "TXT"
  content = "\"v=spf1 include:icloud.com ~all\""
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_google_site_verification" {
  zone_id = cloudflare_zone.nl.id
  name    = "joppekoers.nl"
  type    = "TXT"
  content = "\"google-site-verification=6BGXhHLZ1EtnapQovXYHJnP0ewYTD4MygRL4YL-mIUg\""
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "nl_apple_domain" {
  zone_id = cloudflare_zone.nl.id
  name    = "joppekoers.nl"
  type    = "TXT"
  content = "\"apple-domain=zuC9Z5Vue1ET3UtL\""
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "com_dev" {
  zone_id = cloudflare_zone.com.id
  name    = "dev.joppekoers.com"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.dev_com.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# Originless placeholders so requests reach Cloudflare, where com_redirect sends them to joppekoers.nl.
resource "cloudflare_dns_record" "com_apex" {
  zone_id = cloudflare_zone.com.id
  name    = "joppekoers.com"
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "com_www" {
  zone_id = cloudflare_zone.com.id
  name    = "www.joppekoers.com"
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}
