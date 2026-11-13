locals {
  common_zone_settings = {
    "0rtt"                   = "off"
    always_online            = "off"
    automatic_https_rewrites = "on"
    brotli                   = "on"
    browser_check            = "on"
    cache_level              = "aggressive"
    challenge_ttl            = 1800
    ciphers                  = []
    cname_flattening         = "flatten_at_root"
    early_hints              = "off"
    ech                      = "on"
    email_obfuscation        = "on"
    hotlink_protection       = "off"
    http3                    = "on"
    ip_geolocation           = "on"
    ipv6                     = "on"
    max_upload               = 100
    min_tls_version          = "1.0"
    opportunistic_encryption = "on"
    opportunistic_onion      = "on"
    orange_to_orange         = "off"
    pq_keyex                 = "on"
    pseudo_ipv4              = "off"
    replace_insecure_js      = "on"
    rocket_loader            = "off"
    security_level           = "medium"
    server_side_exclude      = "on"
    tls_1_3                  = "on"
    tls_client_auth          = "off"
    visitor_ip               = "on"
    websockets               = "on"
    security_header = {
      strict_transport_security = {
        enabled            = false
        include_subdomains = false
        max_age            = 0
        nosniff            = false
        preload            = false
      }
    }
  }

  zone_settings = {
    nl = merge(local.common_zone_settings, {
      always_use_https  = "on"
      browser_cache_ttl = 0
      ssl               = "flexible"
    })
    com = merge(local.common_zone_settings, {
      always_use_https  = "off"
      browser_cache_ttl = 14400
      ssl               = "full"
    })
  }
}

# Values are JSON-encoded because for_each needs a map of one type and settings mix strings, numbers, lists and objects.
resource "cloudflare_zone_setting" "nl" {
  for_each   = { for k, v in local.zone_settings.nl : k => jsonencode(v) }
  zone_id    = cloudflare_zone.nl.id
  setting_id = each.key
  value      = jsondecode(each.value)
}

resource "cloudflare_zone_setting" "com" {
  for_each   = { for k, v in local.zone_settings.com : k => jsonencode(v) }
  zone_id    = cloudflare_zone.com.id
  setting_id = each.key
  value      = jsondecode(each.value)
}
