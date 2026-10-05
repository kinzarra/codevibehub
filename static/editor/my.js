document.addEventListener('submit', (e) => {
  const m = e.target.dataset.confirm;
  if (m && !confirm(m)) e.preventDefault();
});
