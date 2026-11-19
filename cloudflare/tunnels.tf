resource "cloudflare_zero_trust_tunnel_cloudflared" "server1" {
  account_id = var.account_id
  name       = "joppekoers.nl"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "offsite" {
  account_id = var.account_id
  name       = "offsite"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "stormtrooper_backup" {
  account_id = var.account_id
  name       = "stormtrooper-backup"
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

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "stormtrooper_backup" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.stormtrooper_backup.id
  config = {
    ingress = [
      { hostname = "stormtrooper-backup.joppekoers.nl", service = "ssh://localhost:22", origin_request = {} },
      { service = "http_status:404" },
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "stormtrooper_backup" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.stormtrooper_backup.id
}

output "stormtrooper_backup_tunnel_token" {
  value     = data.cloudflare_zero_trust_tunnel_cloudflared_token.stormtrooper_backup.token
  sensitive = true
}
