FROM golang:1.24 AS build
ENV GOTOOLCHAIN=auto CGO_ENABLED=0
RUN GOBIN=/out go install github.com/cloudflare/cf-terraforming/cmd/cf-terraforming@v0.31.0

FROM hashicorp/terraform:1.9
COPY --from=build /out/cf-terraforming /usr/local/bin/cf-terraforming
