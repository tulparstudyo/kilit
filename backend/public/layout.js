/* Ortak header ve footer enjeksiyonu */
(function () {
  const token = sessionStorage.getItem('token');
  const user  = JSON.parse(sessionStorage.getItem('user') || '{}');
  const page  = location.pathname.split('/').pop() || 'index.html';

  function active(href) {
    return page === href ? ' class="active"' : '';
  }

  const instToken = sessionStorage.getItem('instToken');

  const guestNav = `
    <a href="login.html"${active('login.html')}>🔐 <span class="nav-label">Giriş Yap</span></a>
    <a href="institution-login.html"${active('institution-login.html')}>🏫 <span class="nav-label">Kurum Girişi</span></a>
    <a href="manuel.html"${active('manuel.html')}>📖 <span class="nav-label">Kurulum</span></a>
    <a href="register.html" class="nav-cta${page==='register.html'?' active':''}">🧑‍💼 <span class="nav-label">Kayıt Ol</span></a>`;

  const userNav = `
    <a href="index.html"${active('index.html')}>🏠 <span class="nav-label">Ana Sayfa</span></a>
    <a href="unlock.html"${active('unlock.html')}>🔓 <span class="nav-label">Kilit Aç</span></a>
    <a href="lock.html"${active('lock.html')}>🔑 <span class="nav-label">Kod Üret</span></a>
    <a href="profile.html"${active('profile.html')}>👤 <span class="nav-label">Profil</span></a>
    <button id="_logoutBtn">🚪 <span class="nav-label">Çıkış</span></button>`;

  const header = `
  <header>
    <a href="index.html" class="logo">🔒 Tulpar Kilit</a>
    <nav>${token ? userNav : guestNav}</nav>
  </header>`;

  const footer = `
  <footer>
    <p>© ${new Date().getFullYear()} Tulpar Kilit &mdash; Pardus Linux için QR tabanlı ekran kilidi</p>
  </footer>`;

  document.body.insertAdjacentHTML('afterbegin', header);
  document.body.insertAdjacentHTML('beforeend', footer);

  document.getElementById('_logoutBtn')?.addEventListener('click', () => {
    sessionStorage.clear();
    location.href = 'index.html';
  });
})();
