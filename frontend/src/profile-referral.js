/**
 * Profile referral section (F0.12b).
 *
 * Inline section inside the Profile view rendering the user's referral
 * handle. Three states:
 *   1. GET /ref/me → 200: show `https://<host>/?ref=<handle>` with copy +
 *      replace/release buttons.
 *   2. GET /ref/me → 404: show `?ref=<wallet>` fallback link with copy +
 *      "Получить читаемое имя" CTA.
 *   3. GET /ref/me → 401: hide the section (caller already requires auth
 *      for /profile, so this is a defensive fallback).
 *
 * Claim modal:
 *   - Live regex validation `^[a-z0-9_-]{4,32}$`, not starting/ending with
 *     `-`/`_`, not in `RESERVED_CODES` (mirrors backend `shared/referral.py`).
 *   - PUT /ref/me on submit. 200 → close + refresh; 409/422 → inline error.
 *
 * Release:
 *   - DELETE /ref/me with a mini-confirm prompt. 204 → refresh.
 *
 * Public API:
 *   mountProfileReferral(container, opts?) -> { destroy, refresh }
 *
 * Spec: docs/plans/frontend.md §F0.12b, docs/api-spec.md §5.2.
 */

import * as defaultApi from './api.js';

const HANDLE_RE = /^[a-z0-9_-]{4,32}$/;

// Client-side mirror of backend `RESERVED_CODES` (shared/referral.py).
// The server is the source of truth — claim still falls through on 422
// `referral.reserved` for anything not in this set.
const RESERVED_CODES = new Set([
  'api', 'admin', 'app', 'auth', 'config', 'health', 'me', 'mine',
  'null', 'ref', 'static', 'stream', 'tokens', 'undefined', 'www',
  'fuck', 'shit', 'cunt', 'nazi', 'hitl', 'suka', 'blya', 'pidr',
]);

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Build the public ref link from a handle or wallet address.
 * Uses `location.origin` when available; falls back to a path-only URL.
 */
function buildRefUrl(value) {
  let origin = '';
  try {
    if (typeof location !== 'undefined' && typeof location.origin === 'string') {
      origin = location.origin;
    }
  } catch {
    /* ignore */
  }
  return `${origin}/?ref=${encodeURIComponent(value)}`;
}

/**
 * Validate a candidate handle. Returns null if OK, or a message key.
 *   - 'empty', 'format', 'edge' (starts/ends with `-`/`_`), 'reserved'.
 */
function validateHandle(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'empty';
  if (!HANDLE_RE.test(raw)) return 'format';
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (first === '-' || first === '_' || last === '-' || last === '_') return 'edge';
  if (RESERVED_CODES.has(raw)) return 'reserved';
  return null;
}

/**
 * Copy `text` to clipboard. Uses Clipboard API when present, falls back to
 * a hidden textarea + execCommand. Returns true on apparent success.
 */
async function copyToClipboard(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   apiClient?: { getRefMe: Function, putRefMe: Function, deleteRefMe: Function },
 *   userAddress?: string,
 * }} [opts]
 */
export function mountProfileReferral(container, opts = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountProfileReferral: container must be an HTMLElement');
  }
  const apiClient = opts.apiClient ?? defaultApi;
  let userAddress = typeof opts.userAddress === 'string' ? opts.userAddress.toLowerCase() : null;

  const state = {
    /** 'unknown' | 'has-handle' | 'no-handle' | 'no-auth' | 'error' */
    status: 'unknown',
    code: null,
    wallet: null,
    reqSeq: 0,
  };

  let modalCleanup = null;
  let destroyed = false;
  let releaseBusy = false;

  // ── DOM scaffold ─────────────────────────────────────────────────────────
  container.replaceChildren();
  const section = el('section', {
    className: 'pt-referral',
    dataset: { testId: 'profile-referral' },
  });
  const title = el('h2', { className: 'pt-referral__title', text: 'Реферальная ссылка' });
  const bodyEl = el('div', { className: 'pt-referral__body' });
  section.appendChild(title);
  section.appendChild(bodyEl);
  container.appendChild(section);

  // Hidden until first load resolves.
  section.hidden = true;

  // ── Renderers ────────────────────────────────────────────────────────────

  function renderHasHandle() {
    bodyEl.replaceChildren();
    const url = buildRefUrl(state.code);

    const linkRow = el('div', { className: 'pt-referral__link-row' });
    linkRow.appendChild(el('span', { className: 'pt-referral__label', text: 'Твоя ссылка:' }));
    const linkEl = el('code', {
      className: 'pt-referral__url',
      dataset: { testId: 'profile-referral-url' },
      text: url,
    });
    linkRow.appendChild(linkEl);
    bodyEl.appendChild(linkRow);

    const actions = el('div', { className: 'pt-referral__actions' });
    actions.appendChild(makeCopyBtn(url, 'profile-referral-copy'));

    const changeBtn = el('button', {
      className: 'pt-btn',
      dataset: { testId: 'profile-referral-change' },
      attrs: { type: 'button' },
      text: 'Сменить handle',
    });
    changeBtn.addEventListener('click', () => openClaimModal({ initial: state.code }));
    actions.appendChild(changeBtn);

    const releaseBtn = el('button', {
      className: 'pt-btn',
      dataset: { testId: 'profile-referral-release' },
      attrs: { type: 'button' },
      text: 'Освободить handle',
    });
    releaseBtn.addEventListener('click', onRelease);
    actions.appendChild(releaseBtn);

    bodyEl.appendChild(actions);
  }

  function renderNoHandle() {
    bodyEl.replaceChildren();
    const addr = (state.wallet || userAddress || '').toLowerCase();
    const url = addr ? buildRefUrl(addr) : '';

    const linkRow = el('div', { className: 'pt-referral__link-row' });
    linkRow.appendChild(el('span', {
      className: 'pt-referral__label',
      text: 'У тебя пока нет читаемого имени. Можно делиться адресом:',
    }));
    if (url) {
      const linkEl = el('code', {
        className: 'pt-referral__url',
        dataset: { testId: 'profile-referral-url' },
        text: url,
      });
      linkRow.appendChild(linkEl);
    }
    bodyEl.appendChild(linkRow);

    const actions = el('div', { className: 'pt-referral__actions' });
    if (url) actions.appendChild(makeCopyBtn(url, 'profile-referral-copy'));

    const claimBtn = el('button', {
      className: 'pt-btn pt-btn--primary',
      dataset: { testId: 'profile-referral-claim' },
      attrs: { type: 'button' },
      text: 'Получить читаемое имя',
    });
    claimBtn.addEventListener('click', () => openClaimModal({ initial: '' }));
    actions.appendChild(claimBtn);
    bodyEl.appendChild(actions);
  }

  function renderLoading() {
    bodyEl.replaceChildren();
    bodyEl.appendChild(el('div', {
      className: 'pt-referral__status',
      dataset: { testId: 'profile-referral-loading' },
      text: 'Загрузка…',
    }));
  }

  function renderError(msg) {
    bodyEl.replaceChildren();
    bodyEl.appendChild(el('div', {
      className: 'pt-referral__status pt-referral__status--err',
      dataset: { testId: 'profile-referral-error' },
      text: msg,
    }));
  }

  function makeCopyBtn(text, testId) {
    const btn = el('button', {
      className: 'pt-btn',
      dataset: { testId },
      attrs: { type: 'button' },
      text: 'Копировать',
    });
    btn.addEventListener('click', async () => {
      const ok = await copyToClipboard(text);
      const orig = btn.textContent;
      btn.textContent = ok ? 'Скопировано' : 'Не удалось';
      btn.disabled = true;
      setTimeout(() => {
        if (destroyed) return;
        btn.textContent = orig || 'Копировать';
        btn.disabled = false;
      }, 1200);
    });
    return btn;
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  async function refresh() {
    const seq = ++state.reqSeq;
    if (state.status === 'unknown') renderLoading();
    let resp = null;
    let err = null;
    try {
      resp = await apiClient.getRefMe();
    } catch (e) {
      err = e;
    }
    if (seq !== state.reqSeq || destroyed) return;

    if (err) {
      const status = err && typeof err.status === 'number' ? err.status : null;
      if (status === 404) {
        state.status = 'no-handle';
        state.code = null;
        section.hidden = false;
        renderNoHandle();
      } else if (status === 401) {
        state.status = 'no-auth';
        section.hidden = true;
      } else {
        state.status = 'error';
        section.hidden = false;
        renderError('Не удалось загрузить реферальную ссылку.');
      }
      return;
    }

    state.status = 'has-handle';
    state.code = typeof resp?.code === 'string' ? resp.code : null;
    state.wallet = typeof resp?.wallet === 'string' ? resp.wallet.toLowerCase() : null;
    section.hidden = false;
    if (state.code) {
      renderHasHandle();
    } else {
      // Defensive — server returned 200 without code somehow.
      renderNoHandle();
    }
  }

  // ── Claim modal ──────────────────────────────────────────────────────────

  function openClaimModal({ initial = '' } = {}) {
    closeModal();

    const overlay = el('div', {
      className: 'pt-modal-overlay',
      dataset: { testId: 'profile-referral-modal' },
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pt-ref-modal-title' },
    });
    const card = el('div', { className: 'pt-modal pt-modal--referral' });
    card.appendChild(el('h2', {
      className: 'pt-modal__title',
      attrs: { id: 'pt-ref-modal-title' },
      text: state.status === 'has-handle' ? 'Сменить handle' : 'Получить читаемое имя',
    }));
    card.appendChild(el('p', {
      className: 'pt-modal__body',
      text: '4–32 символа, буквы a-z, цифры, `-` и `_`. Не может начинаться или заканчиваться на `-`/`_`.',
    }));

    const form = el('form', { className: 'pt-modal__form' });
    const inputWrap = el('div', { className: 'pt-modal__field' });
    const input = el('input', {
      className: 'pt-modal__input',
      dataset: { testId: 'profile-referral-input' },
      attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '32' },
    });
    input.value = initial || '';
    inputWrap.appendChild(input);
    form.appendChild(inputWrap);

    const errEl = el('div', {
      className: 'pt-modal__error',
      dataset: { testId: 'profile-referral-modal-error' },
    });
    errEl.hidden = true;
    form.appendChild(errEl);

    const actions = el('div', { className: 'pt-modal__actions' });
    const cancelBtn = el('button', {
      className: 'pt-btn',
      dataset: { testId: 'profile-referral-modal-cancel' },
      attrs: { type: 'button' },
      text: 'Отмена',
    });
    const submitBtn = el('button', {
      className: 'pt-btn pt-btn--primary',
      dataset: { testId: 'profile-referral-modal-submit' },
      attrs: { type: 'submit' },
      text: 'Зарезервировать',
    });
    submitBtn.disabled = true;
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    form.appendChild(actions);
    card.appendChild(form);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    let busy = false;

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = false;
      input.classList.add('pt-modal__input--err');
    }
    function clearError() {
      errEl.hidden = true;
      errEl.textContent = '';
      input.classList.remove('pt-modal__input--err');
    }

    function onInput() {
      // Normalise to lowercase as user types; cursor at end is fine for short fields.
      const v = input.value.toLowerCase();
      if (v !== input.value) input.value = v;
      const code = validateHandle(v);
      if (code === null) {
        clearError();
        submitBtn.disabled = false;
        return;
      }
      submitBtn.disabled = true;
      // Don't surface errors for empty input — disabled button is enough.
      if (code === 'empty') {
        clearError();
        return;
      }
      const map = {
        format: 'Допустимы a-z, 0-9, `-`, `_`. Длина 4–32.',
        edge: 'Не может начинаться или заканчиваться на `-` или `_`.',
        reserved: 'Это имя зарезервировано.',
      };
      showError(map[code] || 'Неверный формат.');
    }

    async function onSubmit(ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (busy) return;
      const raw = input.value.trim().toLowerCase();
      if (validateHandle(raw) !== null) return;
      busy = true;
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      const origText = submitBtn.textContent;
      submitBtn.textContent = 'Сохраняем…';
      try {
        await apiClient.putRefMe(raw);
        closeModal();
        // Optimistic state — refresh confirms with server.
        state.code = raw;
        state.status = 'has-handle';
        renderHasHandle();
        refresh().catch(() => { /* surfaced via state */ });
      } catch (e) {
        const status = e && typeof e.status === 'number' ? e.status : null;
        const apiCode = e && typeof e.code === 'string' ? e.code : '';
        // 401 — session expired. Keep the modal open is a UX trap (every
        // retry just gets another 401). Close it and hide the section.
        if (status === 401) {
          closeModal();
          state.status = 'no-auth';
          section.hidden = true;
          return;
        }
        let msg = 'Не удалось сохранить.';
        if (status === 409 || apiCode === 'referral.taken') msg = 'Это имя уже занято.';
        else if (apiCode === 'referral.reserved') msg = 'Это имя зарезервировано.';
        else if (apiCode === 'referral.invalid_format') msg = 'Неверный формат имени.';
        showError(msg);
        busy = false;
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = origText || 'Зарезервировать';
      }
    }

    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        closeModal();
      }
    }

    input.addEventListener('input', onInput);
    cancelBtn.addEventListener('click', () => closeModal());
    form.addEventListener('submit', onSubmit);
    document.addEventListener('keydown', onKey);

    // Trigger initial validation if pre-filled.
    onInput();
    try { input.focus(); } catch { /* ignore */ }

    modalCleanup = () => {
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
  }

  function closeModal() {
    if (modalCleanup) {
      try { modalCleanup(); } catch { /* ignore */ }
      modalCleanup = null;
    }
  }

  // ── Release ──────────────────────────────────────────────────────────────

  async function onRelease() {
    if (releaseBusy) return;
    const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm('Освободить handle? Ссылка вернётся к адресу.')
      : true;
    if (!ok) return;
    releaseBusy = true;
    try {
      await apiClient.deleteRefMe();
    } catch {
      // Restore has-handle UI with inline error so the user can retry
      // without leaving the profile view. Backend treats DELETE as
      // idempotent (always 204), so any error here is network/5xx.
      renderHasHandle();
      bodyEl.appendChild(el('div', {
        className: 'pt-referral__status pt-referral__status--err',
        dataset: { testId: 'profile-referral-error' },
        text: 'Не удалось освободить handle. Попробуйте ещё раз.',
      }));
      releaseBusy = false;
      return;
    }
    state.code = null;
    state.wallet = null;
    state.status = 'no-handle';
    renderNoHandle();
    refresh().catch(() => { /* surfaced via state */ });
    releaseBusy = false;
  }

  // ── Public ──────────────────────────────────────────────────────────────

  function destroy() {
    destroyed = true;
    closeModal();
    container.replaceChildren();
  }

  // Kick off initial load.
  refresh();

  return {
    refresh,
    destroy,
    _getState() {
      return {
        status: state.status,
        code: state.code,
        wallet: state.wallet,
        hasModal: modalCleanup !== null,
      };
    },
  };
}
