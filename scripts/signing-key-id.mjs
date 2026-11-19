/**
 * workers の .dev.vars にある署名鍵 ID (CHECKPOINT_SIGNING_KEY_ID) が、verifier の引ける公開鍵
 * (shared の checkpointKeys/registry.ts か localKeys.ts) に載っているかの判定 (#388, #827)。
 *
 * `packages/e2e/scripts/setup-env.mjs` (食い違いなら setup を止める) と `scripts/doctor.mjs`
 * (Section 5 の鍵 ID の項目) の両方がここを使い、同じ入力に同じ答えを返す。
 * localKeys.ts の entry は書き手で形が違う: setup-env は JSON.stringify で `{"keyId":"tcp-e2e-…"}`、
 * gen-checkpoint-key の出力を貼ると `keyId: 'tcp-…'`。どちらも keyId は引用符付きの文字列なので、
 * キーの書き方ではなく「keyId そのものが引用符付きで現れるか」で見る。
 * 秘密 JWK の行は値を保持しない。
 */

/**
 * .dev.vars の本文から CHECKPOINT_SIGNING_KEY_ID の値だけを取り出す。無い・空なら null。
 * 他の行 (秘密 JWK を含む) は値を保持しない。
 */
export function readSigningKeyId(devVarsText) {
  for (const line of devVarsText.split(/\r?\n/)) {
    const match = /^\s*CHECKPOINT_SIGNING_KEY_ID\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    return value === '' ? null : value;
  }
  return null;
}

/** keyId が registry / localKeys のソースのどれかに、引用符付きの文字列として現れるか。 */
export function isKeyIdRegistered(keyId, sourceTexts) {
  return sourceTexts.some((text) => text.includes(`'${keyId}'`) || text.includes(`"${keyId}"`));
}

/** localKeys.ts に `tcp-` の keyId を持つ entry が 1 つでもあるか (キーは引用符の有無を問わない)。 */
function hasCheckpointEntry(localKeysText) {
  return /['"]?keyId['"]?\s*:\s*['"]tcp-/.test(localKeysText);
}

/**
 * doctor の「.dev.vars の keyId が registry.ts / localKeys.ts にあるか」の判定。
 * ファイルが無いときは null を渡す。戻り値は doctor の report にそのまま渡す。
 *
 * @param {{ devVars: string | null, registry: string | null, localKeys: string | null }} texts
 * @param {{ isPlaceholder: (value: string) => boolean }} options
 * @returns {{ status: 'ok' | 'warn' | 'fail', label: string, hint?: string }}
 */
export function judgeSigningKeyId({ devVars, registry, localKeys }, { isPlaceholder }) {
  const devKeyId = devVars ? readSigningKeyId(devVars) : null;

  if (devKeyId && !isPlaceholder(devKeyId)) {
    if (isKeyIdRegistered(devKeyId, [localKeys ?? ''])) {
      return { status: 'ok', label: 'localKeys.ts に dev 鍵 entry あり' };
    }
    if (isKeyIdRegistered(devKeyId, [registry ?? ''])) {
      return {
        status: 'warn',
        label: `localKeys.ts に dev 鍵 entry なし。.dev.vars の keyId (${devKeyId}) は registry.ts に存在`,
        hint: `本番/staging 鍵をローカルに流用している状態。\n別 dev 鍵を生成推奨:\n  npm run gen-checkpoint-key -w @typedcode/workers`,
      };
    }
    return {
      status: 'fail',
      label: `.dev.vars の keyId (${devKeyId}) が registry.ts にも localKeys.ts にもない`,
      hint: 'gen-checkpoint-key を再実行して localKeys.ts に append、ID/JWK を .dev.vars に貼り直す',
    };
  }
  if (hasCheckpointEntry(localKeys ?? '')) {
    return { status: 'ok', label: 'localKeys.ts に dev 鍵 entry あり' };
  }
  return {
    status: 'warn',
    label: 'localKeys.ts に dev 鍵 entry なし、.dev.vars にも keyId なし',
    hint: `署名鍵を生成:\n  npm run gen-checkpoint-key -w @typedcode/workers\n出力の手順に従って localKeys.ts と .dev.vars を埋める`,
  };
}
