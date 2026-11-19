import {
  to = cloudflare_zone.nl
  id = "1c1ae2632c5e4291802a66b6a16f12f7"
}

import {
  to = cloudflare_zone.com
  id = "82674db1833954f5f98b41ccc5aca704"
}

import {
  to = cloudflare_zone_dnssec.nl
  id = "1c1ae2632c5e4291802a66b6a16f12f7"
}

import {
  to = cloudflare_zone_dnssec.com
  id = "82674db1833954f5f98b41ccc5aca704"
}

import {
  for_each = local.zone_settings.nl
  to       = cloudflare_zone_setting.nl[each.key]
  id       = "1c1ae2632c5e4291802a66b6a16f12f7/${each.key}"
}

import {
  for_each = local.zone_settings.com
  to       = cloudflare_zone_setting.com[each.key]
  id       = "82674db1833954f5f98b41ccc5aca704/${each.key}"
}

import {
  to = cloudflare_ruleset.nl_firewall_custom
  id = "zones/1c1ae2632c5e4291802a66b6a16f12f7/bc20854469004b6db83f7eb2cb8f5c38"
}

import {
  to = cloudflare_ruleset.com_redirect
  id = "zones/82674db1833954f5f98b41ccc5aca704/2134d21fbd634045ad9fb8b132a54733"
}

import {
  to = cloudflare_zero_trust_tunnel_cloudflared.server1
  id = "${var.account_id}/1bf15acb-c52e-4dbb-8398-578391b24b0e"
}

import {
  to = cloudflare_zero_trust_tunnel_cloudflared.offsite
  id = "${var.account_id}/3ce77971-3754-4273-91a0-9e7362877663"
}

import {
  to = cloudflare_zero_trust_tunnel_cloudflared.dev_nl
  id = "${var.account_id}/ca7253b5-04df-4038-b40f-8ff5dfa065b5"
}

import {
  to = cloudflare_zero_trust_tunnel_cloudflared.dev_com
  id = "${var.account_id}/3318e294-d41b-4706-808c-a24eb552e66f"
}

import {
  to = cloudflare_zero_trust_tunnel_cloudflared_config.server1
  id = "${var.account_id}/1bf15acb-c52e-4dbb-8398-578391b24b0e"
}

import {
  to = cloudflare_zero_trust_organization.this
  id = var.account_id
}

import {
  to = cloudflare_zero_trust_access_identity_provider.one_time_pin
  id = "accounts/${var.account_id}/7e3eb2ad-d923-483a-8442-aeac83ece066"
}

import {
  to = cloudflare_dns_record.nl_shop_acme_challenge
  id = "1c1ae2632c5e4291802a66b6a16f12f7/9b7c315dbfc5d0355afc75b1453930c8"
}

import {
  to = cloudflare_dns_record.nl_dev
  id = "1c1ae2632c5e4291802a66b6a16f12f7/68ac903120e17d2e07fb4c88b21e7321"
}

import {
  to = cloudflare_dns_record.nl_wildcard
  id = "1c1ae2632c5e4291802a66b6a16f12f7/78f2622fc13960fd598b7f0a27fb3f36"
}

import {
  to = cloudflare_dns_record.nl_apex
  id = "1c1ae2632c5e4291802a66b6a16f12f7/1bd484ab277f20fecb347148a6cb32fd"
}

import {
  to = cloudflare_dns_record.nl_lucas
  id = "1c1ae2632c5e4291802a66b6a16f12f7/6c1a5195c9f22fce1c7562b75748f085"
}

import {
  to = cloudflare_dns_record.nl_shop
  id = "1c1ae2632c5e4291802a66b6a16f12f7/dbe12eb1edeef113079ea8cc99df5299"
}

import {
  to = cloudflare_dns_record.nl_ssh
  id = "1c1ae2632c5e4291802a66b6a16f12f7/64eb7cbbbcf70ac9477254ecd561dbf9"
}

import {
  to = cloudflare_dns_record.nl_terra
  id = "1c1ae2632c5e4291802a66b6a16f12f7/c55e7594fff6ecd76051e41ba2bc83aa"
}

import {
  to = cloudflare_dns_record.nl_mx01
  id = "1c1ae2632c5e4291802a66b6a16f12f7/48828213d5e637912cf6cd3021cc27cb"
}

import {
  to = cloudflare_dns_record.nl_mx02
  id = "1c1ae2632c5e4291802a66b6a16f12f7/c98515ef3f0109e779b9cf81785122f4"
}

import {
  to = cloudflare_dns_record.nl_acme_challenge
  id = "1c1ae2632c5e4291802a66b6a16f12f7/77dabb0ad6d1357c1712952a75438dd2"
}

import {
  to = cloudflare_dns_record.nl_discord
  id = "1c1ae2632c5e4291802a66b6a16f12f7/458f7a2527442fb0cefafd55fac53c9d"
}

import {
  to = cloudflare_dns_record.nl_google_dkim
  id = "1c1ae2632c5e4291802a66b6a16f12f7/18a4259d27d7a677f18c34d3e63382a8"
}

import {
  to = cloudflare_dns_record.nl_spf
  id = "1c1ae2632c5e4291802a66b6a16f12f7/c523fd40714f77c4ca1106fb1f120203"
}

import {
  to = cloudflare_dns_record.nl_google_site_verification
  id = "1c1ae2632c5e4291802a66b6a16f12f7/722dbc973045c451bfa89333d21baa6d"
}

import {
  to = cloudflare_dns_record.nl_apple_domain
  id = "1c1ae2632c5e4291802a66b6a16f12f7/ca274e3fe173d5e59d04bc962cb3ba97"
}

import {
  to = cloudflare_dns_record.com_dev
  id = "82674db1833954f5f98b41ccc5aca704/28b2f88482728bb8157ebac328c91273"
}
