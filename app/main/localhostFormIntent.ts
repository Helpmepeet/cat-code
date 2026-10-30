/** Installed in the preview page world; contains no app capability. */
export function installLocalFormTracking(tracker: { form: { url: string; method: string } | null }): void {
  const submitted = (form: HTMLFormElement, submitter: HTMLElement | null) => {
    try {
      const control = submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null
      const url = control?.hasAttribute('formaction') ? control.formAction : form.action
      const method = control?.hasAttribute('formmethod') ? control.formMethod : form.method
      tracker.form = typeof url === 'string' && url.length <= 4096
        ? { url, method: method.toUpperCase() === 'GET' ? 'GET' : 'POST' }
        : { url: '', method: 'POST' }
    } catch { tracker.form = { url: '', method: 'POST' } }
  }
  addEventListener('submit', event => {
    if (event.target instanceof HTMLFormElement) submitted(event.target, (event as SubmitEvent).submitter)
  }, true)
  const submit = HTMLFormElement.prototype.submit
  HTMLFormElement.prototype.submit = function () { submitted(this, null); return Reflect.apply(submit, this, []) }
}
