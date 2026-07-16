// Injected on demand into the active tab to grab the rendered DOM.
// The completion value of this script is returned to the popup via
// chrome.scripting.executeScript results.
(function () {
  try {
    const doctype = document.doctype
      ? '<!DOCTYPE ' +
        document.doctype.name +
        (document.doctype.publicId ? ' PUBLIC "' + document.doctype.publicId + '"' : '') +
        (document.doctype.systemId ? ' "' + document.doctype.systemId + '"' : '') +
        '>\n'
      : '<!DOCTYPE html>\n';
    const html = doctype + document.documentElement.outerHTML;
    return {
      ok: true,
      url: location.href,
      title: document.title || '',
      html: html,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})();
