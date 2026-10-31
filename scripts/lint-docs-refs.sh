#!/usr/bin/env bash
# docs/ とルートの *.md に `[[...]]` 形式の参照が残っていたら落とす (#343)。
#
# `[[名前]]` は作者のローカル記憶 (メモリ) へのリンク記法で、他の人は辿れない。
# 参照したい先は Issue / PR / ADR へのリンクにするか、平文で書く。
# コードブロック (``` / ~~~) とインラインコード (`...`) の中は対象外
# (例: wrangler.toml の `[[kv_namespaces]]` は TOML の正当な記法)。
#
# 使い方: npm run lint:docs [-- <ルートディレクトリ>]   (既定: このスクリプトの親)
set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$root"

files=()
while IFS= read -r f; do
  files+=("$f")
done < <(
  find docs -type f -name '*.md' | sort
  find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||' | sort
)

hits="$(
  for f in "${files[@]}"; do
    awk -v file="$f" '
      /^[[:space:]]*(```|~~~)/ { fenced = !fenced; next }
      fenced { next }
      {
        line = $0
        gsub(/`[^`]*`/, "", line)
        if (line ~ /\[\[[^]]+\]\]/) printf "%s:%d: %s\n", file, NR, $0
      }
    ' "$f"
  done
)"

if [ -n "$hits" ]; then
  echo 'ローカル記憶参照 [[...]] が残っています。Issue / PR / ADR へのリンクか平文に置き換えてください:' >&2
  echo "$hits" >&2
  exit 1
fi
echo 'docs の [[...]] 参照: なし'
