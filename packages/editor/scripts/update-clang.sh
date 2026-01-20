#!/bin/bash
# Script to update the clang.webc file in Cloudflare R2
#
# Usage: ./scripts/update-clang.sh
#
# This script:
# 1. Downloads the latest clang package from Wasmer CDN
# 2. Uploads it to Cloudflare R2 with version in filename
# 3. Updates CLANG_VERSION in CExecutor.ts
#
# Prerequisites:
#   - wrangler CLI installed and authenticated
#   - curl installed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTOR_FILE="$SCRIPT_DIR/../src/executors/c/CExecutor.ts"
TEMP_DIR=$(mktemp -d)
CLANG_WEBC="$TEMP_DIR/clang.webc"
R2_BUCKET="typedcode-assets"

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

if [ -z "$VERSION" ]; then
    echo "Error: Could not get version from Wasmer registry"
    exit 1
fi

echo "Latest version: $VERSION"
echo "Created at: $CREATED_AT"
echo ""

# Check current version in CExecutor.ts
CURRENT_VERSION=$(grep "const CLANG_VERSION = " "$EXECUTOR_FILE" | grep -o "'[^']*'" | tr -d "'")
echo "Current version in CExecutor.ts: $CURRENT_VERSION"

if [ "$VERSION" = "$CURRENT_VERSION" ]; then
    echo ""
    echo "Already up to date!"
    exit 0
fi

# Get the webc hash
echo ""
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

# Upload to R2 with version in filename
R2_PATH="wasm/clang-${VERSION}.webc"
echo "Uploading to Cloudflare R2 as $R2_PATH..."
npx wrangler r2 object put "$R2_BUCKET/$R2_PATH" \
    --file="$CLANG_WEBC" \
    --content-type="application/octet-stream" \
    --remote

echo ""
echo "✓ Upload complete!"

# Update CExecutor.ts
echo ""
echo "Updating CExecutor.ts..."
sed -i '' "s/const CLANG_VERSION = '.*'/const CLANG_VERSION = '${VERSION}'/" "$EXECUTOR_FILE"

# Verify the update
NEW_VERSION=$(grep "const CLANG_VERSION = " "$EXECUTOR_FILE" | grep -o "'[^']*'" | tr -d "'")
if [ "$NEW_VERSION" = "$VERSION" ]; then
    echo "✓ CExecutor.ts updated to version $VERSION"
else
    echo "Error: Failed to update CExecutor.ts"
    exit 1
fi

echo ""
echo "=== Summary ==="
echo "R2 URL: https://assets.typedcode.dev/$R2_PATH"
echo "Version: $CURRENT_VERSION -> $VERSION"
echo ""
echo "Next steps:"
echo "  1. Test locally: npm run dev:editor"
echo "  2. Commit the change: git add src/executors/c/CExecutor.ts"
echo "  3. Push and deploy"
