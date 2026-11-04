import hashlib, hmac, json, os, re, uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import Flask, jsonify, render_template, request
from dotenv import load_dotenv
from supabase import create_client
from google import genai
from google.genai import types
import mercadopago

load_dotenv()
app = Flask(__name__)
app.secret_key = os.getenv('FLASK_SECRET_KEY','dev-only-change-me')
SB_URL=os.environ.get('SUPABASE_URL',''); SB_ANON=os.environ.get('SUPABASE_ANON_KEY',''); SB_SERVICE=os.environ.get('SUPABASE_SERVICE_ROLE_KEY','')
supabase = create_client(SB_URL, SB_SERVICE) if SB_URL and SB_SERVICE else None
gemini = genai.Client(api_key=os.getenv('GEMINI_API_KEY')) if os.getenv('GEMINI_API_KEY') else None
mp = mercadopago.SDK(os.getenv('MERCADO_PAGO_ACCESS_TOKEN')) if os.getenv('MERCADO_PAGO_ACCESS_TOKEN') else None
BASE_URL=os.getenv('PUBLIC_BASE_URL','http://localhost:5000').rstrip('/')
RESERVATION_MINUTES=int(os.getenv('RESERVATION_MINUTES','15'))
CONDITIONS=['Excelente estado','Estado de colecionador','Bom, com marcas de uso','Ruim, apresenta rasgos','Péssimo, apresenta folhas faltando']

def require_config():
    if not supabase: raise RuntimeError('Configure as variáveis do Supabase.')

def bearer_user():
    token=request.headers.get('Authorization','').removeprefix('Bearer ').strip()
    if not token: return None
    try:
        user=supabase.auth.get_user(token).user
        profile=supabase.table('profiles').select('*').eq('id',str(user.id)).single().execute().data
        return {'id':str(user.id),'email':user.email,'profile':profile}
    except Exception: return None

def auth_required(roles=None):
    def deco(fn):
        @wraps(fn)
        def inner(*a,**kw):
            u=bearer_user()
            if not u: return jsonify(error='Não autenticado'),401
            if roles and u['profile']['role'] not in roles: return jsonify(error='Sem permissão'),403
            return fn(u,*a,**kw)
        return inner
    return deco

def clean_code(value): return re.sub(r'[^A-Z0-9_-]','',str(value or '').upper())[:40]

def release_expired():
    try: supabase.rpc('release_expired_reservations').execute()
    except Exception: pass

@app.get('/')
def index(): return render_template('index.html', supabase_url=SB_URL, anon_key=SB_ANON)
@app.get('/admin')
def admin(): return render_template('admin.html', supabase_url=SB_URL, anon_key=SB_ANON)
@app.get('/health')
def health(): return {'ok':True}

@app.get('/api/stats')
def stats():
    require_config(); release_expired()
    available=supabase.table('comics').select('id',count='exact').eq('status','disponivel').execute().count or 0
    reserved=supabase.table('comics').select('id',count='exact').eq('status','reservado').execute().count or 0
    return {'available':available,'reserved':reserved}

@app.get('/api/catalog')
def catalog():
    require_config(); release_expired()
    q=supabase.table('comics').select('*,profiles!comics_owner_id_fkey(nickname,avatar_url,bio),collections(title,is_complete,lot_discount_percent)').in_('status',['disponivel','reservado'])
    if request.args.get('category'): q=q.eq('character_category',request.args['category'])
    if request.args.get('year'): q=q.eq('publish_year',int(request.args['year']))
    if request.args.get('search'):
        term=request.args['search'].replace('%','').replace(',',' ')[:80]
        q=q.or_(f'title.ilike.%{term}%,character_category.ilike.%{term}%')
    order=request.args.get('order','newest')
    col={'oldest':'publish_year','newest':'created_at','year_desc':'publish_year'}.get(order,'created_at')
    desc=order in ('newest','year_desc')
    rows=q.order(col,desc=desc).limit(min(int(request.args.get('limit',60)),100)).execute().data
    recent=supabase.table('comics').select('*,profiles!comics_owner_id_fkey(nickname,avatar_url)').eq('status','disponivel').order('created_at',desc=True).limit(12).execute().data
    return {'items':rows,'recent':recent}

@app.post('/api/process-comic-photo')
@auth_required({'admin','collaborator'})
def process_photo(user):
    if not gemini: return jsonify(error='GEMINI_API_KEY não configurada'),503
    data=request.get_json(force=True); b64=data.get('image_base64','').split(',')[-1]
    if not b64: return jsonify(error='Imagem ausente'),400
    notes=str(data.get('notes',''))[:1500]
    schema=types.Schema(type=types.Type.OBJECT,properties={
      'title':types.Schema(type=types.Type.STRING),'issue_number':types.Schema(type=types.Type.INTEGER),
      'publish_year':types.Schema(type=types.Type.INTEGER),'character_category':types.Schema(type=types.Type.STRING),
      'condition':types.Schema(type=types.Type.STRING,enum=CONDITIONS),'suggested_price':types.Schema(type=types.Type.NUMBER),
      'description':types.Schema(type=types.Type.STRING),'is_rare':types.Schema(type=types.Type.BOOLEAN)
    },required=['title','issue_number','publish_year','character_category','condition','suggested_price','description','is_rare'])
    prompt=('Analise a capa desta HQ brasileira. Estime dados conservadoramente. O preço é apenas sugestão, não uma cotação garantida. '
            'Escreva descrição vendedora honesta em pt-BR e incorpore defeitos sem mencionar nota interna. Observações: '+(notes or 'nenhuma'))
    try:
        raw=__import__('base64').b64decode(b64)
        resp=gemini.models.generate_content(model=os.getenv('GEMINI_MODEL','gemini-2.5-flash'),contents=[prompt,types.Part.from_bytes(data=raw,mime_type='image/webp')],config=types.GenerateContentConfig(response_mime_type='application/json',response_schema=schema))
        return jsonify(json.loads(resp.text))
    except Exception as e: return jsonify(error=f'Falha na análise: {e}'),502

@app.post('/api/comics')
@auth_required({'admin','collaborator'})
def create_comic(user):
    d=request.get_json(force=True)
    required=['title','condition','sale_price','image_url']
    if any(not d.get(x) for x in required): return jsonify(error='Campos obrigatórios ausentes'),400
    row={k:d.get(k) for k in ['collection_id','title','issue_number','publish_year','character_category','condition','suggested_price','sale_price','max_discount_percent','description','internal_notes','image_url','is_rare']}
    row['owner_id']=user['id']; row['suggested_price']=row['suggested_price'] or row['sale_price']; row['description']=row['description'] or ''
    created=supabase.table('comics').insert(row).execute().data[0]
    if row.get('collection_id'): supabase.rpc('refresh_collection_complete',{'p_collection':row['collection_id']}).execute()
    return jsonify(created),201

@app.patch('/api/comics/<comic_id>')
@auth_required({'admin','collaborator'})
def edit_comic(user,comic_id):
    current=supabase.table('comics').select('owner_id').eq('id',comic_id).single().execute().data
    if user['profile']['role']!='admin' and current['owner_id']!=user['id']: return jsonify(error='Só o dono pode editar'),403
    allowed={'title','issue_number','publish_year','character_category','condition','suggested_price','sale_price','max_discount_percent','description','internal_notes','collection_id','is_rare','status'}
    patch={k:v for k,v in request.get_json(force=True).items() if k in allowed}
    return jsonify(supabase.table('comics').update(patch).eq('id',comic_id).execute().data[0])

@app.delete('/api/comics/<comic_id>')
@auth_required({'admin','collaborator'})
def delete_comic(user,comic_id):
    current=supabase.table('comics').select('owner_id').eq('id',comic_id).single().execute().data
    if user['profile']['role']!='admin' and current['owner_id']!=user['id']: return jsonify(error='Só o dono pode excluir'),403
    supabase.table('comics').update({'status':'inativo'}).eq('id',comic_id).execute(); return '',204

@app.post('/api/admin/collaborators')
@auth_required({'admin'})
def create_collaborator(user):
    d=request.get_json(force=True)
    created=supabase.auth.admin.create_user({'email':d['email'],'password':d['password'],'email_confirm':True})
    row={'id':str(created.user.id),'role':'collaborator','full_name':d['full_name'],'nickname':d['nickname'],'avatar_url':d.get('avatar_url'),'bio':d.get('bio')}
    supabase.table('profiles').insert(row).execute(); return jsonify({**row,'email':d['email']}),201

@app.post('/api/admin/coupons')
@auth_required({'admin'})
def create_coupon(user):
    d=request.get_json(force=True); row={'code':clean_code(d['code']),'discount_percent':float(d['discount_percent']),'active':True,'expires_at':d.get('expires_at') or None,'max_uses':d.get('max_uses') or None,'created_by':user['id']}
    return jsonify(supabase.table('coupons').insert(row).execute().data[0]),201

@app.post('/api/checkout')
def checkout():
    require_config(); release_expired()
    d=request.get_json(force=True); ids=list(dict.fromkeys(d.get('comic_ids',[])))
    buyer=d.get('buyer',{}); required=['name','email','whatsapp']
    if not ids or any(not buyer.get(k) for k in required): return jsonify(error='Carrinho ou comprador incompleto'),400
    comics=supabase.table('comics').select('id,title,sale_price,max_discount_percent,owner_id,status').in_('id',ids).execute().data
    if len(comics)!=len(ids) or any(c['status']!='disponivel' for c in comics): return jsonify(error='Um ou mais itens não estão disponíveis'),409
    subtotal=sum(float(c['sale_price']) for c in comics); discount_pct=0; code=clean_code(d.get('coupon'))
    if code:
        found=supabase.table('coupons').select('*').eq('code',code).eq('active',True).limit(1).execute().data
        if not found: return jsonify(error='Cupom inválido'),400
        cp=found[0]; now=datetime.now(timezone.utc)
        if cp.get('expires_at') and datetime.fromisoformat(cp['expires_at'].replace('Z','+00:00')) < now: return jsonify(error='Cupom expirado'),400
        if cp.get('max_uses') and cp['use_count']>=cp['max_uses']: return jsonify(error='Cupom esgotado'),400
        discount_pct=float(cp['discount_percent'])
    proposal=float(d.get('proposal_percent') or 0)
    if proposal:
        allowed=min(float(c['max_discount_percent']) for c in comics)
        if proposal>allowed: return jsonify(error=f'Proposta supera a margem permitida de {allowed:.2f}%'),400
        discount_pct=max(discount_pct,proposal)
    discount=round(subtotal*discount_pct/100,2); total=round(subtotal-discount,2)
    token=str(uuid.uuid4()); until=(datetime.now(timezone.utc)+timedelta(minutes=RESERVATION_MINUTES)).isoformat()
    # Optimistic conditional updates prevent double reservation.
    for c in comics:
        result=supabase.table('comics').update({'status':'reservado','reserved_until':until,'reservation_token':token}).eq('id',c['id']).eq('status','disponivel').execute().data
        if not result:
            supabase.table('comics').update({'status':'disponivel','reserved_until':None,'reservation_token':None}).eq('reservation_token',token).execute()
            return jsonify(error='Outro comprador reservou um item agora'),409
    order={'buyer_name':buyer['name'],'buyer_email':buyer['email'],'buyer_whatsapp':buyer['whatsapp'],'reservation_token':token,'coupon_code':code or None,'subtotal':subtotal,'discount':discount,'total':total}
    o=supabase.table('orders').insert(order).execute().data[0]
    supabase.table('order_items').insert([{'order_id':o['id'],'comic_id':c['id'],'owner_id':c['owner_id'],'title':c['title'],'unit_price':c['sale_price'],'final_price':round(float(c['sale_price'])*(1-discount_pct/100),2)} for c in comics]).execute()
    if not mp: return jsonify(order_id=o['id'],reservation_token=token,total=total,warning='Mercado Pago não configurado'),201
    preference={'items':[{'id':c['id'],'title':c['title'][:120],'quantity':1,'currency_id':'BRL','unit_price':round(float(c['sale_price'])*(1-discount_pct/100),2)} for c in comics], 'payer':{'name':buyer['name'],'email':buyer['email']},'external_reference':o['id'],'notification_url':f'{BASE_URL}/api/mercadopago/webhook','back_urls':{'success':f'{BASE_URL}/?payment=success','failure':f'{BASE_URL}/?payment=failure','pending':f'{BASE_URL}/?payment=pending'},'auto_return':'approved','expires':True,'expiration_date_to':until}
    res=mp.preference().create(preference); body=res['response']
    supabase.table('orders').update({'mp_preference_id':str(body.get('id'))}).eq('id',o['id']).execute()
    return jsonify(order_id=o['id'],reservation_token=token,total=total,init_point=body.get('init_point'),sandbox_init_point=body.get('sandbox_init_point')),201

def valid_mp_signature():
    secret=os.getenv('MERCADO_PAGO_WEBHOOK_SECRET','')
    if not secret: return True
    x_sig=request.headers.get('x-signature',''); x_request=request.headers.get('x-request-id','')
    parts=dict(p.split('=',1) for p in x_sig.split(',') if '=' in p); ts=parts.get('ts',''); v1=parts.get('v1','')
    data_id=str(request.args.get('data.id') or (request.get_json(silent=True) or {}).get('data',{}).get('id','')).lower()
    manifest=f'id:{data_id};request-id:{x_request};ts:{ts};'
    expected=hmac.new(secret.encode(),manifest.encode(),hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected,v1)

@app.post('/api/mercadopago/webhook')
def mp_webhook():
    if not valid_mp_signature(): return jsonify(error='Assinatura inválida'),401
    payload=request.get_json(silent=True) or {}; payment_id=request.args.get('data.id') or payload.get('data',{}).get('id')
    if not payment_id or not mp: return '',200
    payment=mp.payment().get(payment_id).get('response',{}); order_id=payment.get('external_reference'); status=payment.get('status')
    if not order_id: return '',200
    order=supabase.table('orders').select('*').eq('id',order_id).single().execute().data
    mapped={'approved':'approved','rejected':'rejected','cancelled':'cancelled'}.get(status,'pending')
    supabase.table('orders').update({'status':mapped,'mp_payment_id':str(payment_id)}).eq('id',order_id).execute()
    if status=='approved':
        supabase.table('comics').update({'status':'vendido','reserved_until':None}).eq('reservation_token',order['reservation_token']).execute()
        if order.get('coupon_code'): supabase.rpc('increment_coupon_use',{'p_code':order['coupon_code']}).execute()
    elif status in ('rejected','cancelled'):
        supabase.table('comics').update({'status':'disponivel','reserved_until':None,'reservation_token':None}).eq('reservation_token',order['reservation_token']).execute()
    return '',200

if __name__=='__main__': app.run(host='0.0.0.0',port=int(os.getenv('PORT','5000')),debug=True)
