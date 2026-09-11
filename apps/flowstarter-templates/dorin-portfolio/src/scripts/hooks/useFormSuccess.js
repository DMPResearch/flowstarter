// This template is a static site with no backend to receive a POST, so a
// "submit" that silently goes nowhere would be worse than one that hands the
// message to the visitor's own mail client. When a mailto address is
// supplied, we compose a mailto: URL from the form's own fields and open it;
// otherwise the form behaves exactly as before (reveal the success message,
// no network request).
export function useFormSuccess({ formSelector, successSelector, mailto, onSuccess }) {
  const form = document.querySelector(formSelector);
  const successMessage = document.querySelector(successSelector);

  if (!form || !successMessage) {
    return;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    if (!form.reportValidity()) {
      return;
    }

    if (mailto) {
      const data = new FormData(form);
      const name = String(data.get('fullName') ?? '').trim();
      const lines = [];
      for (const [field, value] of data.entries()) {
        const text = String(value).trim();
        if (text) {
          lines.push(`${field}: ${text}`);
        }
      }
      const subject = name ? `Enquiry from ${name}` : 'Enquiry from the website';
      window.location.href =
        `mailto:${mailto}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
    }

    successMessage.hidden = false;
    form.reset();
    onSuccess?.();
  });
}
