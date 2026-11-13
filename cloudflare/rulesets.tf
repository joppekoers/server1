resource "cloudflare_ruleset" "nl_firewall_custom" {
  zone_id = cloudflare_zone.nl.id
  name    = "default"
  kind    = "zone"
  phase   = "http_request_firewall_custom"
  rules = [
    {
      description = "skip challenge for watchtower deploy hook"
      expression  = "(http.host eq \"joppekoers.nl\" and starts_with(http.request.uri.path, \"/watchtower/\"))"
      action      = "skip"
      action_parameters = {
        ruleset = "current"
      }
      logging = {
        enabled = true
      }
    },
    {
      description = "always challenge"
      expression  = "(not http.host in {\"joppekoers.nl\" \"pixels.joppekoers.nl\"})"
      action      = "managed_challenge"
    },
  ]
}

resource "cloudflare_ruleset" "com_redirect" {
  zone_id = cloudflare_zone.com.id
  name    = "default"
  kind    = "zone"
  phase   = "http_request_dynamic_redirect"
  rules = [
    {
      description = "Redirect to joppekoers.nl"
      expression  = "(http.host ne \"dev.joppekoers.com\")"
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code           = 302
          preserve_query_string = true
          target_url = {
            expression = "concat(\"https://joppekoers.nl\", http.request.uri.path)"
          }
        }
      }
    },
  ]
}

resource "cloudflare_ruleset" "nl_cache" {
  zone_id = cloudflare_zone.nl.id
  name    = "Cache settings"
  kind    = "zone"
  phase   = "http_request_cache_settings"
  rules = [
    {
      description = "respect origin cache-control"
      expression  = "(http.host eq \"joppekoers.nl\")"
      action      = "set_cache_settings"
      action_parameters = {
        cache       = true
        edge_ttl    = { mode = "respect_origin" }
        browser_ttl = { mode = "respect_origin" }
      }
    },
  ]
}
