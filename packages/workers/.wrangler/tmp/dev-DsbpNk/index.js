var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
__name(corsHeaders, "corsHeaders");
function handleCORS(request) {
  const origin = request.headers.get("Origin");
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin)
  });
}
__name(handleCORS, "handleCORS");
async function createHmacSignature(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(createHmacSignature, "createHmacSignature");
async function verifyTurnstile(token, secretKey) {
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      secret: secretKey,
      response: token
    })
  });
  return response.json();
}
__name(verifyTurnstile, "verifyTurnstile");
async function createAttestation(result, attestationSecret) {
  const attestationData = {
    verified: result.success,
    score: 1,
    // Turnstile has no score, always 1.0 on success
    action: result.action ?? "unknown",
    timestamp: result.challenge_ts,
    hostname: result.hostname
  };
  const dataToSign = JSON.stringify(attestationData);
  const signature = await createHmacSignature(dataToSign, attestationSecret);
  return {
    ...attestationData,
    signature
  };
}
__name(createAttestation, "createAttestation");
async function handleVerifyCaptcha(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json();
    const { token } = body;
    if (!token) {
      return new Response(
        JSON.stringify({
          success: false,
          score: 0,
          message: "Token is required"
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin)
          }
        }
      );
    }
    const result = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY);
    const isVerified = result.success;
    let attestation;
    if (isVerified && env.ATTESTATION_SECRET_KEY) {
      attestation = await createAttestation(result, env.ATTESTATION_SECRET_KEY);
    }
    const response = {
      success: isVerified,
      score: isVerified ? 1 : 0,
      message: result.success ? "Verified" : `Verification failed: ${result["error-codes"]?.join(", ") ?? "Unknown error"}`,
      attestation
    };
    return new Response(JSON.stringify(response), {
      status: response.success ? 200 : 403,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(origin)
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        score: 0,
        message: "Internal server error"
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(origin)
        }
      }
    );
  }
}
__name(handleVerifyCaptcha, "handleVerifyCaptcha");
async function handleVerifyAttestation(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json();
    const { attestation } = body;
    if (!attestation) {
      return new Response(
        JSON.stringify({ valid: false, message: "Attestation is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin)
          }
        }
      );
    }
    const { signature, success: _success, failureReason: _failureReason, ...coreData } = attestation;
    const attestationData = {
      verified: coreData.verified,
      score: coreData.score,
      action: coreData.action,
      timestamp: coreData.timestamp,
      hostname: coreData.hostname
    };
    const dataToSign = JSON.stringify(attestationData);
    const expectedSignature = await createHmacSignature(dataToSign, env.ATTESTATION_SECRET_KEY);
    const isValid = signature === expectedSignature;
    return new Response(
      JSON.stringify({
        valid: isValid,
        message: isValid ? "Attestation is valid" : "Invalid signature",
        attestation: isValid ? attestationData : void 0
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(origin)
        }
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ valid: false, message: "Internal server error" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(origin)
        }
      }
    );
  }
}
__name(handleVerifyAttestation, "handleVerifyAttestation");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return handleCORS(request);
    }
    if (url.pathname === "/api/verify-captcha" && request.method === "POST") {
      return handleVerifyCaptcha(request, env);
    }
    if (url.pathname === "/api/verify-attestation" && request.method === "POST") {
      return handleVerifyAttestation(request, env);
    }
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", environment: env.ENVIRONMENT }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("Not Found", { status: 404 });
  }
};

// ../../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-KdTEmB/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-KdTEmB/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
