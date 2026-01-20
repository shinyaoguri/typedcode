#!/bin/bash
# Script to update the clang.webc file from Wasmer registry
#
# Usage: ./scripts/update-clang.sh
#
# This script fetches the latest clang package from Wasmer registry
# and updates the local webc file.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WASM_DIR="$SCRIPT_DIR/../public/wasm"
CLANG_WEBC="$WASM_DIR/clang.webc"

echo "=== Clang WebC Updater ==="

# Check current version info
if [ -f "$CLANG_WEBC" ]; then
    CURRENT_SIZE=$(ls -lh "$CLANG_WEBC" | awk '{print $5}')
    echo "Current file size: $CURRENT_SIZE"
fi

# Query Wasmer registry for latest version
echo ""
echo "Checking Wasmer registry for latest version..."
VERSION_INFO=$(curl -s "https://registry.wasmer.io/graphql" -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"{ getPackageVersion(name: \"syrusakbary/clang\") { version createdAt }}"}')

VERSION=$(echo "$VERSION_INFO" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
CREATED_AT=$(echo "$VERSION_INFO" | grep -o '"createdAt":"[^"]*"' | cut -d'"' -f4)

echo "Latest version: $VERSION"
echo "Created at: $CREATED_AT"

# Get the webc URL from Wasmer
# Note: The webc hash can be found on the package page or via API
echo ""
echo "To download, you need to find the webc hash from:"
echo "  https://wasmer.io/syrusakbary/clang"
echo ""
echo "Then run:"
echo "  curl -L -o '$CLANG_WEBC' 'https://cdn.wasmer.io/webcimages/<HASH>.webc'"
echo ""

# Ask user for the webc hash
read -p "Enter the webc hash (or press Enter to skip): " WEBC_HASH

if [ -n "$WEBC_HASH" ]; then
    echo ""
    echo "Downloading clang.webc..."

    # Create backup
    if [ -f "$CLANG_WEBC" ]; then
        cp "$CLANG_WEBC" "$CLANG_WEBC.backup"
        echo "Backup created: $CLANG_WEBC.backup"
    fi

    # Download new file
    curl -L -o "$CLANG_WEBC" "https://cdn.wasmer.io/webcimages/${WEBC_HASH}.webc"

    # Verify the file
    if head -c 5 "$CLANG_WEBC" | grep -q "webc"; then
        NEW_SIZE=$(ls -lh "$CLANG_WEBC" | awk '{print $5}')
        echo ""
        echo "✓ Download successful!"
        echo "  New file size: $NEW_SIZE"
        echo ""
        echo "Next steps:"
        echo "  1. Test locally: npm run dev:editor"
        echo "  2. Commit the change: git add public/wasm/clang.webc"
        echo "  3. Git LFS will handle the large file automatically"

        # Remove backup if successful
        rm -f "$CLANG_WEBC.backup"
    else
        echo ""
        echo "✗ Error: Downloaded file is not a valid webc file"
        echo "  Restoring backup..."
        if [ -f "$CLANG_WEBC.backup" ]; then
            mv "$CLANG_WEBC.backup" "$CLANG_WEBC"
        fi
        exit 1
    fi
else
    echo "Skipping download."
fi
