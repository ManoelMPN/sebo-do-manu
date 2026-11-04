# Sebo do Manu

SaaS Flask + Supabase + Gemini + Mercado Pago, preparado para Codespaces e Vercel.

## 1. Supabase
1. Crie um projeto gratuito em https://supabase.com/dashboard.
2. Abra **SQL Editor**, cole `schema.sql` e execute.
3. Em **Authentication > Users**, crie seu usuário Admin.
4. Copie o UUID e rode no SQL Editor:
   ```sql
   insert into public.profiles(id,role,full_name,nickname)
   values ('UUID_DO_USUARIO','admin','Manoel','Manu');
   ```
5. Em **Project Settings > API**, copie Project URL, anon key e service_role. Nunca exponha a service_role no navegador.

## 2. GitHub Codespaces
1. Suba esta pasta num repositório GitHub e clique **Code > Codespaces > Create codespace**.
2. No terminal:
   ```bash
   cp .env.example .env
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   python app.py
   ```
3. Edite `.env`. Abra a porta 5000 quando o Codespaces oferecer.
4. Acesse `/admin`, entre com o Admin e cadastre colaboradores, cupons e HQs.

## 3. Chaves
### Gemini
Crie a chave no Google AI Studio, coloque em `GEMINI_API_KEY` e mantenha `GEMINI_MODEL=gemini-2.5-flash`. A IA sugere preço, mas o Admin deve revisar antes de publicar.

### Mercado Pago
Em Mercado Pago Developers, crie uma aplicação de Checkout Pro. Copie o Access Token para `MERCADO_PAGO_ACCESS_TOKEN`. Configure o webhook de pagamentos em `https://SEU-DOMINIO/api/mercadopago/webhook`, copie a assinatura secreta e salve em `MERCADO_PAGO_WEBHOOK_SECRET`.

## 4. Vercel
1. Envie o código ao GitHub.
2. Em https://vercel.com/new, importe o repositório.
3. Em **Settings > Environment Variables**, cadastre todas as variáveis do `.env.example`.
4. Use a URL final em `PUBLIC_BASE_URL`, sem barra no final, e faça novo deploy.
5. Atualize a URL do webhook no painel do Mercado Pago.

## Observações de produção
- A liberação de reservas ocorre ao consultar catálogo/estatísticas. Para alto volume, agende `select public.release_expired_reservations();` com Supabase Cron.
- Vercel serve Flask diretamente. Para otimização avançada, mova estáticos para `public/`.
- Antes de vender, teste credenciais de sandbox, webhook, concorrência de dois compradores e política de reembolso.
- “Custo zero” depende dos limites gratuitos e pode mudar conforme consumo e regras dos provedores.
