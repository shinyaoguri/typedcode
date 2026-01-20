#!/bin/bash
# Script to update the clang.webc file in Cloudflare R2
#
# Usage: ./scripts/update-clang.sh
#
# This script downloads the latest clang package from Wasmer CDN
# and uploads it to Cloudflare R2.
#
# Prerequisites:
#   - wrangler CLI installed and authenticated
#   - curl installed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR=$(mktemp -d)
CLANG_WEBC="$TEMP_DIR/clang.webc"
R2_BUCKET="typedcode-assets"
R2_PATH="wasm/clang.webc"

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "=== Clang WebC Updater (Cloudflare R2) ==="
echo ""

# Check prerequisites
if ! command -v npx &> /dev/null; then
    echo "Error: npx is not installed."
    exit 1
fi

# Query Wasmer registry for latest version
echo "Checking Wasmer registry for latest version..."
VERSION_INFO=$(curl -s "https://registry.wasmer.io/graphql" -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"{ getPackageVersion(name: \"syrusakbary/clang\") { version createdAt }}"}')

VERSION=$(echo "$VERSION_INFO" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
CREATED_AT=$(echo "$VERSION_INFO" | grep -o '"createdAt":"[^"]*"' | cut -d'"' -f4)

echo "Latest version: $VERSION"
echo "Created at: $CREATED_AT"
echo ""

# Get the webc hash
echo "To download, you need to find the webc hash from:"
echo "  https://wasmer.io/syrusakbary/clang"
echo ""
read -p "Enter the webc hash: " WEBC_HASH

if [ -z "$WEBC_HASH" ]; then
    echo "Error: webc hash is required"
    exit 1
fi

# Download the file
echo ""
echo "Downloading clang.webc..."
curl -L -o "$CLANG_WEBC" "https://cdn.wasmer.io/webcimages/${WEBC_HASH}.webc"

# Verify the file
if ! head -c 5 "$CLANG_WEBC" | grep -q "webc"; then
    echo "Error: Downloaded file is not a valid webc file"
    exit 1
fi

FILE_SIZE=$(ls -lh "$CLANG_WEBC" | awk '{print $5}')
echo "Downloaded: $FILE_SIZE"
echo ""

# Upload to R2
echo "Uploading to Cloudflare R2..."
npx wrangler r2 object put "$R2_BUCKET/$R2_PATH" \
    --file="$CLANG_WEBC" \
    --content-type="application/octet-stream" \
    --remote

echo ""
echo "✓ Upload complete!"
echo ""
echo "R2 URL: https://assets.typedcode.dev/$R2_PATH"
echo ""
echo "Note: If you set up a custom domain, update the URL in CExecutor.ts"
