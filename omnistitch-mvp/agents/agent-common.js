/**
 * Checks whether one HTMLElement is visible for mode-toggle interaction.
 * Exposed globally so each site adapter can reuse the same UI heuristics.
 * @param {HTMLElement} element
 * @returns {boolean}
 */
globalThis.isVisibleElement = function isVisibleElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.offsetParent !== null) {
    return true;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

/**
 * Reads one mode control text from visible label/title attributes.
 * @param {HTMLElement} element
 * @returns {string}
 */
globalThis.readModeControlText = function readModeControlText(element) {
  if (!(element instanceof HTMLElement)) {
    return '';
  }

  return normalizeCapturedText(
    element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || ''
  );
};

/**
 * Determines whether a mode control currently looks selected/active.
 * @param {HTMLElement} element
 * @returns {boolean}
 */
globalThis.isActiveModeControl = function isActiveModeControl(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const ariaPressed = String(element.getAttribute('aria-pressed') || '').toLowerCase();
  const ariaChecked = String(element.getAttribute('aria-checked') || '').toLowerCase();
  const className = String(element.className || '').toLowerCase();
  return (
    ariaPressed === 'true' ||
    ariaChecked === 'true' ||
    /active|selected|checked|enabled|on|current/.test(className)
  );
};

/**
 * Collects all visible button-like controls for site-specific mode switching.
 * @returns {HTMLElement[]}
 */
globalThis.collectModeControls = function collectModeControls() {
  const selectors = ['button', '[role="button"]', 'div[role="button"]'];
  const controls = [];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));
    for (const element of elements) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (!isVisibleElement(element)) {
        continue;
      }

      controls.push(element);
    }
  }

  return controls;
};

/**
 * Clicks one mode control if it is interactable.
 * @param {HTMLElement} element
 * @returns {boolean}
 */
globalThis.clickModeControl = function clickModeControl(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element instanceof HTMLButtonElement && element.disabled) {
    return false;
  }

  if (window.getComputedStyle(element).pointerEvents === 'none') {
    return false;
  }

  element.click();
  return true;
};
