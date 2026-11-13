resource "cloudflare_zero_trust_tunnel_cloudflared" "server1" {
  account_id = var.account_id
  name       = "joppekoers.nl"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "asus_laptop" {
  account_id = var.account_id
  name       = "asus-laptop"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "offsite" {
  account_id = var.account_id
  name       = "offsite"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "stormtrooper" {
  account_id = var.account_id
  name       = "stormtrooper"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "dev_nl" {
  account_id = var.account_id
  name       = "dev.joppekoers.nl"
  config_src = "local"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "dev_com" {
  account_id = var.account_id
  name       = "dev.joppekoers.com"
  config_src = "local"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "server1" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.server1.id
  config = {
    ingress = [
      { hostname = "ssh.joppekoers.nl", service = "ssh://192.168.2.23:22", origin_request = {} },
      { hostname = "joppekoers.nl", service = "http://nginx:80", origin_request = {} },
      { hostname = "*.joppekoers.nl", service = "http://nginx:80", origin_request = {} },
      { service = "http_status:404" },
    ]
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "asus_laptop" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.asus_laptop.id
  config = {
    ingress = [
      { hostname = "asus-laptop.joppekoers.nl", service = "ssh://192.168.1.116:22", origin_request = {} },
      { service = "http_status:404" },
    ]
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "offsite" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.offsite.id
  config = {
    ingress = [
      { hostname = "offsite.joppekoers.nl", service = "ssh://localhost:22" },
      { service = "http_status:404" },
    ]
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "stormtrooper" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.stormtrooper.id
  config = {
    ingress = [
      { hostname = "stormtrooper.joppekoers.nl", service = "ssh://192.168.1.155:22", origin_request = {} },
      { service = "http_status:404" },
    ]
  }
}
