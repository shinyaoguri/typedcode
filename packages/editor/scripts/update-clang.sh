#!/bin/bash
# Script to update the clang.webc file in GitHub Releases
#
# Usage: ./scripts/update-clang.sh
#
# This script downloads the latest clang package from Wasmer CDN
# and uploads it to GitHub Releases.
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - curl installed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR=$(mktemp -d)
CLANG_WEBC="$TEMP_DIR/clang.webc"
REPO="shinyaoguri/typedcode"
RELEASE_TAG="wasm-assets"

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "=== Clang WebC Updater ==="
echo ""

# Check prerequisites
if ! command -v gh &> /dev/null; then
    echo "Error: gh CLI is not installed. Install it with: brew install gh"
    exit 1
fi

if ! gh auth status &> /dev/null; then
    echo "Error: gh CLI is not authenticated. Run: gh auth login"
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

# Check if release exists
if gh release view "$RELEASE_TAG" --repo "$REPO" &> /dev/null; then
    echo "Updating existing release: $RELEASE_TAG"

    # Delete old asset if exists
    gh release delete-asset "$RELEASE_TAG" clang.webc --repo "$REPO" --yes 2>/dev/null || true

    # Upload new asset
    gh release upload "$RELEASE_TAG" "$CLANG_WEBC" --repo "$REPO"
else
    echo "Creating new release: $RELEASE_TAG"
    gh release create "$RELEASE_TAG" \
        --title "WASM Assets" \
        --notes "Static WASM assets for the editor (clang compiler v$VERSION)" \
        --repo "$REPO" \
        "$CLANG_WEBC"
fi

echo ""
echo "✓ Upload complete!"
echo ""
echo "Release URL: https://github.com/$REPO/releases/tag/$RELEASE_TAG"
echo "Download URL: https://github.com/$REPO/releases/download/$RELEASE_TAG/clang.webc"
