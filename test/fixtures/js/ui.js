// Event handlers are passed around, not called.
class View {
  constructor(el) {
    el.addEventListener('click', this.onClick.bind(this));
    el.addEventListener('keyup', this.onKey);
  }

  onClick() {}

  onKey() {}
}

function save() {}

export const actions = { save };

export function wire(btn) {
  btn.on('press', save);
}
