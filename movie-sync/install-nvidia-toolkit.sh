#!/bin/bash
# Installs the NVIDIA Container Toolkit so Docker containers can access the host GPU.
# This is required for movie-sync to use hardware-accelerated HEVC encoding (hevc_nvenc).
#
# Prerequisites:
#   - NVIDIA GPU with drivers already installed on the host (verify with: nvidia-smi)
#   - Docker installed
#
# Usage: sudo ./install-nvidia-toolkit.sh
#
# After running this script, add the GPU reservation to docker-compose.yaml:
#   deploy:
#     resources:
#       reservations:
#         devices:
#           - driver: nvidia
#             count: all
#             capabilities: [gpu]
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Run as root: sudo $0"
  exit 1
fi

echo "Adding NVIDIA Container Toolkit repository..."
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

echo "Installing nvidia-container-toolkit..."
sudo apt update
sudo apt install -y nvidia-container-toolkit

echo "Configuring Docker runtime..."
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker

echo "Verifying GPU access in Docker..."
docker run --rm --gpus all nvidia/cuda:12.9.0-base-ubuntu24.04 nvidia-smi

echo "Done"
