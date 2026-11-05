const cfg = window.APP_CONFIG || {};

const $ = selector => document.querySelector(selector);

const money = value =>
  Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });

let catalog = [];
let cart = JSON.parse(localStorage.getItem('cart') || '[]');


/* =========================================================
   UTILITÁRIOS
   ========================================================= */

function toast(message, duration = 4000) {
  const element = $('#toast');

  if (!element) {
    console.log(message);
    return;
  }

  element.textContent = message;
  element.style.display = 'block';

  clearTimeout(element._timer);

  element._timer = setTimeout(() => {
    element.style.display = 'none';
  }, duration);
}


function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}


function safeImageUrl(value) {
  const url = String(value || '').trim();

  if (
    url.startsWith('https://') ||
    url.startsWith('http://') ||
    url.startsWith('data:image/')
  ) {
    return url;
  }

  return '';
}


function placeholderAvatar() {
  return (
    'data:image/svg+xml;charset=UTF-8,' +
    encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
        <rect width="80" height="80" fill="#e2e8f0"/>
        <circle cx="40" cy="31" r="15" fill="#94a3b8"/>
        <path d="M14 76c2-18 13-27 26-27s24 9 26 27" fill="#94a3b8"/>
      </svg>
    `)
  );
}


function setButtonBusy(button, busy, busyText = 'Processando...') {
  if (!button) {
    return;
  }

  if (busy) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent.trim();
    }

    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    button.textContent = busyText;
  } else {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');

    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
    }
  }
}


function setFormBusy(form, busy, busyText = 'Processando...') {
  if (!form) {
    return;
  }

  const submitButton = form.querySelector(
    'button[type="submit"], input[type="submit"], button'
  );

  const controls = form.querySelectorAll(
    'input, select, textarea, button'
  );

  controls.forEach(control => {
    if (busy) {
      control.dataset.previousDisabled = String(control.disabled);
      control.disabled = true;
    } else {
      control.disabled = control.dataset.previousDisabled === 'true';
      delete control.dataset.previousDisabled;
    }
  });

  setButtonBusy(submitButton, busy, busyText);
}


function updateBusyText(form, text) {
  const button = form?.querySelector(
    'button[type="submit"], input[type="submit"], button'
  );

  if (button) {
    button.textContent = text;
  }
}


function beginFormProcessing(form, text) {
  if (!form || form.dataset.processing === 'true') {
    return false;
  }

  form.dataset.processing = 'true';
  setFormBusy(form, true, text);

  return true;
}


function endFormProcessing(form) {
  if (!form) {
    return;
  }

  form.dataset.processing = 'false';
  setFormBusy(form, false);
}


function timeoutFetch(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => {
    clearTimeout(timer);
  });
}


/* =========================================================
   API
   ========================================================= */

async function api(url, options = {}) {
  let response;

  try {
    response = await timeoutFetch(
      url,
      {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      },
      options.timeoutMs || 60000
    );
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(
        'A operação passou do tempo limite. Aguarde um minuto e tente novamente.'
      );
    }

    throw new Error(
      'Não foi possível conectar ao servidor. Verifique a internet e tente novamente.'
    );
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  let data;

  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      throw new Error(
        `O servidor retornou um JSON inválido (${response.status}).`
      );
    }
  } else {
    const responseText = await response.text();

    console.error('Resposta inesperada do servidor:', {
      url,
      status: response.status,
      contentType,
      responseText
    });

    if (response.status === 503) {
      throw new Error(
        'A inteligência artificial está congestionada. Aguarde um minuto e tente novamente.'
      );
    }

    if (response.status === 504) {
      throw new Error(
        'A análise demorou mais que o limite da Vercel. Aguarde um minuto e tente novamente.'
      );
    }

    if (response.status === 404) {
      throw new Error(
        'A rota solicitada não foi encontrada no servidor.'
      );
    }

    if (response.status >= 500) {
      throw new Error(
        `O servidor apresentou uma falha temporária (${response.status}).`
      );
    }

    throw new Error(
      `O servidor devolveu uma resposta inesperada (${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error ||
      data?.message ||
      `Falha na operação (${response.status}).`
    );
  }

  return data;
}


/* =========================================================
   VITRINE
   ========================================================= */

function card(comic) {
  const seller = comic.profiles || {};
  const collection = comic.collections || {};

  const title = escapeHtml(comic.title || 'HQ sem título');
  const condition = escapeHtml(comic.condition || 'Estado não informado');
  const year = escapeHtml(
    comic.publish_year || 'Ano não identificado'
  );
  const issue = escapeHtml(comic.issue_number || '?');

  const nickname = escapeHtml(seller.nickname || 'Manu');
  const bio = escapeHtml(seller.bio || '');
  const avatar =
    safeImageUrl(seller.avatar_url) || placeholderAvatar();

  const image =
    safeImageUrl(comic.image_url) || placeholderAvatar();

  let badge = condition;

  if (comic.is_rare) {
    badge = '🔥 Rara';
  } else if (collection.is_complete) {
    badge = '⭐ Coleção Completa';
  }

  const unavailable = comic.status !== 'disponivel';

  return `
    <article class="card">
      <span class="badge">${badge}</span>

      <img
        src="${image}"
        alt="Capa de ${title}"
        loading="lazy"
      >

      <div class="card-body">
        <small>
          ${year} · Edição ${issue}
        </small>

        <h3>${title}</h3>

        <p class="price">
          ${money(comic.sale_price)}
        </p>

        <div
          class="seller"
          tabindex="0"
          role="button"
          data-name="${nickname}"
          data-bio="${bio}"
          data-avatar="${avatar}"
        >
          <img
            src="${avatar}"
            alt=""
            loading="lazy"
          >

          <span>Vendido por: ${nickname}</span>
        </div>

        <button
          type="button"
          class="add"
          data-id="${escapeHtml(comic.id)}"
          ${unavailable ? 'disabled' : ''}
        >
          ${unavailable ? 'Reservada' : 'Adicionar'}
        </button>
      </div>
    </article>
  `;
}


async function loadStore() {
  const stats = await api('/api/stats');

  if ($('#available')) {
    $('#available').textContent = stats.available;
  }

  if ($('#reserved')) {
    $('#reserved').textContent = stats.reserved;
  }

  const params = new URLSearchParams({
    search: $('#search')?.value || '',
    year: $('#year')?.value || '',
    category: $('#category')?.value || '',
    order: $('#order')?.value || 'newest'
  });

  const data = await api(`/api/catalog?${params.toString()}`);

  catalog = data.items || [];

  if ($('#catalog')) {
    $('#catalog').innerHTML = catalog.length
      ? catalog.map(card).join('')
      : '<p class="empty-message">Nenhuma HQ encontrada.</p>';
  }

  if ($('#recent')) {
    $('#recent').innerHTML = data.recent?.length
      ? data.recent.map(card).join('')
      : '<p class="empty-message">Nenhuma HQ cadastrada ainda.</p>';
  }

  bindCards();
  renderCart();
}


function bindCards() {
  document.querySelectorAll('.add').forEach(button => {
    button.addEventListener('click', () => {
      const comicId = button.dataset.id;

      if (!cart.includes(comicId)) {
        cart.push(comicId);
      }

      saveCart();
    });
  });

  document.querySelectorAll('.seller').forEach(element => {
    const openSeller = () => {
      const avatar = safeImageUrl(element.dataset.avatar);

      if ($('#sellerInfo')) {
        $('#sellerInfo').innerHTML = `
          ${
            avatar
              ? `<img class="avatar" src="${avatar}" alt="">`
              : ''
          }

          <h2>${escapeHtml(element.dataset.name)}</h2>

          <p>
            ${
              escapeHtml(element.dataset.bio) ||
              'Este vendedor ainda não cadastrou uma biografia.'
            }
          </p>
        `;
      }

      $('#sellerModal')?.showModal();
    };

    element.addEventListener('click', openSeller);

    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSeller();
      }
    });
  });
}


function saveCart(showMessage = true) {
  localStorage.setItem('cart', JSON.stringify(cart));
  renderCart();

  if (showMessage) {
    toast('Carrinho atualizado.');
  }
}


function renderCart() {
  if (!$('#cartCount')) {
    return;
  }

  $('#cartCount').textContent = cart.length;

  const items = catalog.filter(comic =>
    cart.includes(comic.id)
  );

  if (!$('#cartItems')) {
    return;
  }

  $('#cartItems').innerHTML = items.length
    ? items
        .map(
          comic => `
            <div class="cart-row">
              <span>${escapeHtml(comic.title)}</span>

              <b>${money(comic.sale_price)}</b>

              <button
                type="button"
                class="remove-cart"
                data-id="${escapeHtml(comic.id)}"
                aria-label="Remover ${escapeHtml(comic.title)}"
              >
                ×
              </button>
            </div>
          `
        )
        .join('')
    : '<p>Carrinho vazio.</p>';

  document.querySelectorAll('.remove-cart').forEach(button => {
    button.addEventListener('click', () => {
      removeCart(button.dataset.id);
    });
  });
}


function removeCart(id) {
  cart = cart.filter(comicId => comicId !== id);
  saveCart();
}


/* =========================================================
   IMAGENS
   ========================================================= */

async function compressWebP(file) {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('O arquivo selecionado não é uma imagem válida.');
  }

  let bitmap;

  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      'Não foi possível abrir a imagem. Tente usar JPG, PNG ou WebP.'
    );
  }

  const maximumWidth = 1000;
  const scale = Math.min(1, maximumWidth / bitmap.width);

  const canvas = document.createElement('canvas');

  canvas.width = Math.max(
    1,
    Math.round(bitmap.width * scale)
  );

  canvas.height = Math.max(
    1,
    Math.round(bitmap.height * scale)
  );

  const context = canvas.getContext('2d');

  if (!context) {
    bitmap.close?.();
    throw new Error('O navegador não conseguiu preparar a imagem.');
  }

  context.drawImage(
    bitmap,
    0,
    0,
    canvas.width,
    canvas.height
  );

  bitmap.close?.();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      result => {
        if (result) {
          resolve(result);
        } else {
          reject(
            new Error('Não foi possível converter a imagem para WebP.')
          );
        }
      },
      'image/webp',
      0.8
    );
  });

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(new Error('Não foi possível ler a imagem comprimida.'));

    reader.readAsDataURL(blob);
  });

  return {
    blob,
    dataUrl,
    originalSize: file.size,
    compressedSize: blob.size
  };
}


/* =========================================================
   ADMINISTRAÇÃO
   ========================================================= */

async function initAdmin() {
  if (
    typeof supabase === 'undefined' ||
    !supabase.createClient
  ) {
    throw new Error(
      'A biblioteca do Supabase não foi carregada.'
    );
  }

  if (!cfg.supabaseUrl || !cfg.anonKey) {
    throw new Error(
      'As configurações públicas do Supabase não foram carregadas.'
    );
  }

  const sb = supabase.createClient(
    cfg.supabaseUrl,
    cfg.anonKey
  );

  let {
    data: { session }
  } = await sb.auth.getSession();


  function showAdminState() {
    if ($('#loginPanel')) {
      $('#loginPanel').hidden = Boolean(session);
    }

    if ($('#adminPanel')) {
      $('#adminPanel').hidden = !session;
    }
  }


  async function ensureSession() {
    const result = await sb.auth.getSession();

    session = result.data.session;

    if (!session) {
      showAdminState();
      throw new Error(
        'Sua sessão terminou. Entre novamente no painel.'
      );
    }

    return session;
  }


  async function authed(url, body, method = 'POST') {
    const activeSession = await ensureSession();

    return api(url, {
      method,
      headers: {
        Authorization:
          `Bearer ${activeSession.access_token}`
      },
      body: body === undefined
        ? undefined
        : JSON.stringify(body),
      timeoutMs: 65000
    });
  }


  showAdminState();


  if ($('#loginForm')) {
    $('#loginForm').onsubmit = async event => {
      event.preventDefault();

      const form = event.currentTarget;

      if (!beginFormProcessing(form, 'Entrando...')) {
        return;
      }

      try {
        const formData = new FormData(form);

        const result = await sb.auth.signInWithPassword({
          email: String(formData.get('email') || '').trim(),
          password: String(formData.get('password') || '')
        });

        if (result.error) {
          throw new Error(result.error.message);
        }

        session = result.data.session;
        form.reset();
        showAdminState();
        toast('Login realizado com sucesso.');
      } catch (error) {
        toast(error.message);
      } finally {
        endFormProcessing(form);
      }
    };
  }


  if ($('#logout')) {
    $('#logout').onclick = async event => {
      const button = event.currentTarget;

      setButtonBusy(button, true, 'Saindo...');

      try {
        await sb.auth.signOut();
        session = null;
        location.reload();
      } catch (error) {
        toast(error.message);
        setButtonBusy(button, false);
      }
    };
  }


  if ($('#comicForm')) {
    $('#comicForm').onsubmit = async event => {
      event.preventDefault();

      const form = event.currentTarget;
      const files = [...($('#images')?.files || [])];

      if (!files.length) {
        toast('Escolha pelo menos uma imagem.');
        return;
      }

      if (
        !beginFormProcessing(
          form,
          `Preparando 1 de ${files.length}...`
        )
      ) {
        return;
      }

      const notes = $('#notes')?.value || '';
      const maxDiscount = Number(
        $('#maxDiscount')?.value || 0
      );

      const progress = $('#progress');
      const results = $('#results');

      let completed = 0;
      let succeeded = 0;
      let failed = 0;

      if (progress) {
        progress.value = 0;
        progress.max = 100;
      }

      if (results) {
        results.innerHTML = '';
      }

      try {
        for (const [index, file] of files.entries()) {
          let uploadedPath = null;

          try {
            updateBusyText(
              form,
              `Comprimindo ${index + 1} de ${files.length}...`
            );

            const image = await compressWebP(file);

            updateBusyText(
              form,
              `Analisando ${index + 1} de ${files.length}...`
            );

            if (results) {
              results.insertAdjacentHTML(
                'afterbegin',
                `
                  <p class="processing-message">
                    ⏳ Analisando ${escapeHtml(file.name)}...
                  </p>
                `
              );
            }

            const analysis = await authed(
              '/api/process-comic-photo',
              {
                image_base64: image.dataUrl,
                notes
              }
            );

            updateBusyText(
              form,
              `Enviando ${index + 1} de ${files.length}...`
            );

            uploadedPath =
              `${session.user.id}/${crypto.randomUUID()}.webp`;

            const uploadResult = await sb.storage
              .from('comics')
              .upload(uploadedPath, image.blob, {
                contentType: 'image/webp',
                cacheControl: '3600',
                upsert: false
              });

            if (uploadResult.error) {
              throw new Error(
                `Falha no envio da imagem: ${uploadResult.error.message}`
              );
            }

            const publicUrlResult = sb.storage
              .from('comics')
              .getPublicUrl(uploadedPath);

            const imageUrl =
              publicUrlResult.data?.publicUrl;

            if (!imageUrl) {
              throw new Error(
                'O Supabase não retornou a URL pública da imagem.'
              );
            }

            updateBusyText(
              form,
              `Cadastrando ${index + 1} de ${files.length}...`
            );

            await authed('/api/comics', {
              ...analysis,
              sale_price: analysis.suggested_price,
              max_discount_percent: maxDiscount,
              internal_notes: notes,
              image_url: imageUrl
            });

            succeeded++;

            if (results) {
              results.insertAdjacentHTML(
                'afterbegin',
                `
                  <p class="success-message">
                    ✓ ${escapeHtml(file.name)}:
                    ${escapeHtml(analysis.title)}
                  </p>
                `
              );
            }
          } catch (error) {
            failed++;

            /*
             * Se a imagem chegou ao Storage, mas o cadastro no banco
             * falhou, remove o arquivo para não ocupar espaço sem uso.
             */
            if (uploadedPath) {
              const removeResult = await sb.storage
                .from('comics')
                .remove([uploadedPath]);

              if (removeResult.error) {
                console.error(
                  'Não foi possível remover a imagem órfã:',
                  removeResult.error
                );
              }
            }

            if (results) {
              results.insertAdjacentHTML(
                'afterbegin',
                `
                  <p class="error-message">
                    ✗ ${escapeHtml(file.name)}:
                    ${escapeHtml(error.message)}
                  </p>
                `
              );
            }
          } finally {
            completed++;

            if (progress) {
              progress.value =
                (completed / files.length) * 100;
            }
          }
        }

        if (failed === 0) {
          toast(
            `${succeeded} HQ(s) cadastrada(s) com sucesso.`
          );

          form.reset();

          if ($('#maxDiscount')) {
            $('#maxDiscount').value = 10;
          }
        } else if (succeeded > 0) {
          toast(
            `${succeeded} cadastrada(s) e ${failed} com erro.`,
            6000
          );
        } else {
          toast(
            'Nenhuma HQ foi cadastrada. Consulte as mensagens abaixo.',
            6000
          );
        }
      } finally {
        endFormProcessing(form);
      }
    };
  }


  if ($('#collabForm')) {
    $('#collabForm').onsubmit = async event => {
      event.preventDefault();

      const form = event.currentTarget;

      if (
        !beginFormProcessing(
          form,
          'Criando colaborador...'
        )
      ) {
        return;
      }

      try {
        const data = Object.fromEntries(
          new FormData(form)
        );

        await authed(
          '/api/admin/collaborators',
          data
        );

        form.reset();
        toast('Colaborador criado com sucesso.');
      } catch (error) {
        toast(error.message, 6000);
      } finally {
        endFormProcessing(form);
      }
    };
  }


  if ($('#couponForm')) {
    $('#couponForm').onsubmit = async event => {
      event.preventDefault();

      const form = event.currentTarget;

      if (
        !beginFormProcessing(
          form,
          'Criando cupom...'
        )
      ) {
        return;
      }

      try {
        const data = Object.fromEntries(
          new FormData(form)
        );

        if (data.expires_at) {
          data.expires_at =
            new Date(data.expires_at).toISOString();
        } else {
          data.expires_at = null;
        }

        data.max_uses = data.max_uses
          ? Number(data.max_uses)
          : null;

        data.discount_percent =
          Number(data.discount_percent);

        await authed(
          '/api/admin/coupons',
          data
        );

        form.reset();
        toast('Cupom criado com sucesso.');
      } catch (error) {
        toast(error.message, 6000);
      } finally {
        endFormProcessing(form);
      }
    };
  }
}


/* =========================================================
   INICIALIZAÇÃO
   ========================================================= */

document.addEventListener('DOMContentLoaded', () => {
  document
    .querySelectorAll('dialog .close')
    .forEach(button => {
      button.addEventListener('click', () => {
        button.closest('dialog')?.close();
      });
    });

  if (document.body.dataset.page === 'store') {
    loadStore().catch(error => {
      toast(error.message, 6000);
    });


    if ($('#filterBtn')) {
      $('#filterBtn').onclick = async event => {
        const button = event.currentTarget;

        setButtonBusy(button, true, 'Filtrando...');

        try {
          await loadStore();
        } catch (error) {
          toast(error.message, 6000);
        } finally {
          setButtonBusy(button, false);
        }
      };
    }


    if ($('#cartBtn')) {
      $('#cartBtn').onclick = () => {
        renderCart();
        $('#cartModal')?.showModal();
      };
    }


    if ($('#checkoutForm')) {
      $('#checkoutForm').onsubmit = async event => {
        event.preventDefault();

        const form = event.currentTarget;

        if (!cart.length) {
          toast('Adicione pelo menos uma HQ ao carrinho.');
          return;
        }

        if (
          !beginFormProcessing(
            form,
            'Reservando itens...'
          )
        ) {
          return;
        }

        try {
          const formData = new FormData(form);

          const result = await api('/api/checkout', {
            method: 'POST',
            body: JSON.stringify({
              comic_ids: cart,
              buyer: {
                name: formData.get('name'),
                email: formData.get('email'),
                whatsapp: formData.get('whatsapp')
              },
              coupon: formData.get('coupon'),
              proposal_percent:
                formData.get('proposal')
            }),
            timeoutMs: 60000
          });

          cart = [];
          saveCart(false);

          if (result.init_point) {
            updateBusyText(
              form,
              'Abrindo Mercado Pago...'
            );

            location.href = result.init_point;
            return;
          }

          toast(
            `Reserva criada: ${money(result.total)}`
          );

          form.reset();
          $('#cartModal')?.close();

          await loadStore();
        } catch (error) {
          toast(error.message, 6000);
        } finally {
          endFormProcessing(form);
        }
      };
    }


    /*
     * Atualiza os números e o catálogo sem sobrepor
     * uma atualização anterior.
     */
    let refreshing = false;

    setInterval(async () => {
      if (refreshing || document.hidden) {
        return;
      }

      refreshing = true;

      try {
        await loadStore();
      } catch (error) {
        console.warn(
          'Falha na atualização automática:',
          error
        );
      } finally {
        refreshing = false;
      }
    }, 30000);
  } else {
    initAdmin().catch(error => {
      toast(error.message, 7000);
      console.error(error);
    });
  }
});