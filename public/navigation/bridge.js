// Route navigation into NoteIDE tabs instead of opening operating-system windows.
window.open = function (value) {
    try {
        const url = new URL(value, location.href);
        if (['https:', 'http:'].includes(url.protocol)) {
            parent.postMessage({ type: 'noteide:navigate', url: url.href }, location.origin);
        }
    } catch { /* Invalid imported addresses cannot be opened. */ }
    return null;
};
document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (link && /^https?:/i.test(link.getAttribute('href'))) {
        event.preventDefault();
        window.open(link.href);
    }
}, true);
