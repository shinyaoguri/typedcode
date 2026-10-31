#!/usr/bin/env bash
# .github/workflows/ を actionlint (+ shellcheck) で検査する (#351)。
#
# なぜ要るか: pull_request_target / schedule で動く workflow (pr-checks・pr-title・labeler・
# freshness) は、壊れていても PR の CI には現れない。次にそのイベントが来たとき、失敗ではなく
# 空振りとして現れるので、PR が緑のまま気付けない。式・イベント名・run: のシェルをここで見る。
#
# なぜ両方をピンするか: actionlint は shellcheck があれば run: の中身も検査するが、shellcheck の
# 有無と版はランナーのイメージや手元の環境次第。「あれば使う」にすると CI とローカルで検査範囲が
# 変わり、片方だけ黙って緩くなる。そこで actionlint と shellcheck の両方を固定版で落とし、
# sha256 を照合してから使う (手元の PATH にあるものは使わない)。
#
# 版の上げ方 (dependabot では上がらないので手で行う):
#   1. 下の ACTIONLINT_VERSION / SHELLCHECK_VERSION を書き換える
#   2. pick_assets の照合値を OS / arch ごとに取り直す
#        curl -fsSL https://github.com/rhysd/actionlint/releases/download/v<ver>/actionlint_<ver>_checksums.txt
#        curl -fsSL https://github.com/koalaman/shellcheck/releases/download/v<ver>/shellcheck-v<ver>.<os>.<arch>.tar.gz | shasum -a 256
#   3. npm run lint:workflows で新しい指摘が出ないか確かめる (出たら同じ PR で直す)
#
# 使い方: npm run lint:workflows [-- <actionlint の引数>]
set -euo pipefail

ACTIONLINT_VERSION="1.7.12"
SHELLCHECK_VERSION="0.11.0"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# .cache/ は gitignore 済み。版が変われば置き場も変わるので、古い版を誤って使わない
TOOLS_DIR="${ROOT}/.cache/actionlint/${ACTIONLINT_VERSION}-shellcheck-${SHELLCHECK_VERSION}"
ACTIONLINT="${TOOLS_DIR}/actionlint"
SHELLCHECK="${TOOLS_DIR}/shellcheck"

# 走っている機械に合う配布物と照合値を選ぶ。想定外の環境では別物を落とさずに止まる
pick_assets() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)
      ACTIONLINT_ASSET="actionlint_${ACTIONLINT_VERSION}_darwin_arm64.tar.gz"
      ACTIONLINT_SHA256="aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f"
      SHELLCHECK_ASSET="shellcheck-v${SHELLCHECK_VERSION}.darwin.aarch64.tar.gz"
      SHELLCHECK_SHA256="339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f"
      ;;
    Darwin/x86_64)
      ACTIONLINT_ASSET="actionlint_${ACTIONLINT_VERSION}_darwin_amd64.tar.gz"
      ACTIONLINT_SHA256="5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644"
      SHELLCHECK_ASSET="shellcheck-v${SHELLCHECK_VERSION}.darwin.x86_64.tar.gz"
      SHELLCHECK_SHA256="c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51"
      ;;
    Linux/x86_64)
      ACTIONLINT_ASSET="actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
      ACTIONLINT_SHA256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
      SHELLCHECK_ASSET="shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.gz"
      SHELLCHECK_SHA256="b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6"
      ;;
    Linux/aarch64 | Linux/arm64)
      ACTIONLINT_ASSET="actionlint_${ACTIONLINT_VERSION}_linux_arm64.tar.gz"
      ACTIONLINT_SHA256="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"
      SHELLCHECK_ASSET="shellcheck-v${SHELLCHECK_VERSION}.linux.aarch64.tar.gz"
      SHELLCHECK_SHA256="68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc"
      ;;
    *)
      echo "error: 未対応の環境 ($(uname -s) $(uname -m))。対応は macOS arm64/x86_64 と Linux x86_64/aarch64" >&2
      exit 1
      ;;
  esac
}

# fetch <url> <期待する sha256> <保存先>。照合に失敗したら配布物を消して止まる
# (改竄・取り違えを実行しない。照合失敗は取り直さない)
fetch() {
  local url=$1 expected=$2 out=$3 actual
  echo "取得中: ${url}" >&2
  curl -fsSL --retry 3 --retry-all-errors -o "$out" "$url"
  actual="$(shasum -a 256 "$out" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    rm -f "$out"
    echo "error: sha256 が一致しない: $(basename "$url")" >&2
    echo "  期待: ${expected}" >&2
    echo "  実際: ${actual}" >&2
    exit 1
  fi
}

install_tools() {
  pick_assets
  local staging
  mkdir -p "$(dirname "$TOOLS_DIR")"
  staging="$(mktemp -d "${TOOLS_DIR}.tmp.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT

  fetch "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${ACTIONLINT_ASSET}" \
    "$ACTIONLINT_SHA256" "${staging}/actionlint.tar.gz"
  fetch "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/${SHELLCHECK_ASSET}" \
    "$SHELLCHECK_SHA256" "${staging}/shellcheck.tar.gz"

  tar -xzf "${staging}/actionlint.tar.gz" -C "$staging" actionlint
  tar -xzf "${staging}/shellcheck.tar.gz" -C "$staging" --strip-components=1 \
    "shellcheck-v${SHELLCHECK_VERSION}/shellcheck"
  rm -f "${staging}/actionlint.tar.gz" "${staging}/shellcheck.tar.gz"

  # 2 本とも揃ってから置き場へ移す (途中で落ちても半端な展開を「展開済み」と誤認しない)
  rm -rf "$TOOLS_DIR"
  mv "$staging" "$TOOLS_DIR"
  trap - EXIT
}

if [ ! -x "$ACTIONLINT" ] || [ ! -x "$SHELLCHECK" ]; then
  install_tools
fi

exec "$ACTIONLINT" -shellcheck "$SHELLCHECK" "$@"
