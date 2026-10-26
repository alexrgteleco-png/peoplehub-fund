// PeopleHub Fund · pequeñas mejoras en el navegador (la web funciona también sin JavaScript).
(function () {
  'use strict';

  // Confirmación antes de gastar créditos.
  document.addEventListener('submit', function (event) {
    var button = event.submitter || event.target.querySelector('[data-confirm]');
    var message = button && button.getAttribute('data-confirm');
    if (message && !window.confirm(message)) event.preventDefault();
  });

  // Muestra solo los campos del modo de desarrollador elegido.
  document.querySelectorAll('[data-dev-choice]').forEach(function (box) {
    function update() {
      var checked = box.querySelector('input[name="devMode"]:checked');
      var mode = checked ? checked.value : 'open';
      box.querySelectorAll('[data-dev-group]').forEach(function (group) {
        group.hidden = group.getAttribute('data-dev-group') !== mode;
      });
    }
    box.addEventListener('change', update);
    update();
  });
})();
