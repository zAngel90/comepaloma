import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

// Configuración de Culqi
const CULQI_PUBLIC_KEY = 'pk_live_YIRE7Q5zul6JOrQ2';
const CULQI_SECRET_KEY = 'sk_live_wuCv3TIHJmK04dR3';
const CULQI_API_URL = 'https://api.culqi.com/v2';

// PocketBase URL
const POCKETBASE_URL = 'https://vc538717831202.coderick.net';

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'https://vc538717831202.coderick.net'],
  credentials: true
}));
app.use(express.json());

// Helper para hacer peticiones a Culqi
async function culqiRequest(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${CULQI_SECRET_KEY}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${CULQI_API_URL}${endpoint}`, options);
  const data = await response.json();

  if (!response.ok) {
    throw { status: response.status, ...data };
  }

  return data;
}

// Helper para actualizar usuario en PocketBase
async function updatePocketBaseUser(email, subscriptionData) {
  try {
    // Autenticar como admin
    const authResponse = await fetch(`${POCKETBASE_URL}/api/admins/auth-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity: 'admin@palmeritos.com',
        password: 'Palmeritos2026!'
      })
    });

    if (!authResponse.ok) {
      console.error('Error autenticando admin en PocketBase');
      return false;
    }

    const { token } = await authResponse.json();

    // Buscar usuario por email
    const usersResponse = await fetch(
      `${POCKETBASE_URL}/api/collections/users/records?filter=(email='${email}')`,
      { headers: { 'Authorization': token } }
    );

    const usersData = await usersResponse.json();

    if (usersData.items && usersData.items.length > 0) {
      const userId = usersData.items[0].id;

      // Actualizar suscripción del usuario
      await fetch(`${POCKETBASE_URL}/api/collections/users/records/${userId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(subscriptionData)
      });

      return true;
    }

    return false;
  } catch (error) {
    console.error('Error actualizando PocketBase:', error);
    return false;
  }
}

// ==========================================
// ENDPOINT: Crear cargo único (pagos simples)
// ==========================================
app.post('/api/charge', async (req, res) => {
  try {
    const { token_id, amount, currency_code, email, description, metadata } = req.body;

    if (!token_id || !amount || !email) {
      return res.status(400).json({
        success: false,
        error: 'Faltan campos requeridos: token_id, amount, email'
      });
    }

    // Crear cargo en Culqi
    const charge = await culqiRequest('/charges', 'POST', {
      amount: Math.round(amount * 100), // Convertir a céntimos
      currency_code: currency_code || 'PEN',
      email,
      source_id: token_id,
      description: description || 'Pago en Palmeritos Centro para las Artes',
      capture: true,
      antifraud_details: {
        address: metadata?.address || 'Lima',
        address_city: metadata?.city || 'Lima',
        country_code: 'PE',
        first_name: metadata?.first_name || 'Cliente',
        last_name: metadata?.last_name || 'Palmeritos',
        phone_number: metadata?.phone || '999999999'
      },
      metadata: {
        ...metadata,
        service: metadata?.service || 'pago_unico'
      }
    });

    console.log('✅ Cargo exitoso:', charge.id, '- S/', amount);

    res.json({
      success: true,
      charge_id: charge.id,
      amount: charge.amount / 100,
      currency: charge.currency_code,
      message: 'Pago procesado exitosamente'
    });

  } catch (error) {
    console.error('❌ Error en cargo:', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.merchant_message || error.user_message || 'Error procesando el pago',
      code: error.code || 'UNKNOWN_ERROR'
    });
  }
});

// ==========================================
// ENDPOINT: Crear suscripción recurrente
// ==========================================
app.post('/api/subscription', async (req, res) => {
  try {
    const { token_id, email, plan_id, customer_data } = req.body;

    if (!token_id || !email) {
      return res.status(400).json({
        success: false,
        error: 'Faltan campos requeridos: token_id, email'
      });
    }

    // Paso 1: Crear o buscar cliente
    let customer;
    try {
      customer = await culqiRequest('/customers', 'POST', {
        email,
        first_name: customer_data?.first_name || 'Cliente',
        last_name: customer_data?.last_name || 'Palmeritos',
        address: customer_data?.address || 'Lima, Perú',
        address_city: customer_data?.city || 'Lima',
        country_code: 'PE',
        phone_number: customer_data?.phone || '999999999'
      });
      console.log('✅ Cliente creado:', customer.id);
    } catch (error) {
      if (error.merchant_message?.includes('existe') || error.code === 'customer_already_exists') {
        const customers = await culqiRequest(`/customers?email=${email}`);
        if (customers.data && customers.data.length > 0) {
          customer = customers.data[0];
          console.log('ℹ️ Cliente existente:', customer.id);
        } else {
          throw new Error('No se pudo encontrar el cliente');
        }
      } else {
        throw error;
      }
    }

    // Paso 2: Crear tarjeta
    let card;
    try {
      card = await culqiRequest('/cards', 'POST', {
        customer_id: customer.id,
        token_id: token_id,
        validate: true
      });
      console.log('✅ Tarjeta creada:', card.id);
    } catch (error) {
      console.error('❌ Error creando tarjeta:', error);
      throw { ...error, step: 'card_creation' };
    }

    // Paso 3: Verificar/Crear plan de Videos Premium
    let planId = plan_id || process.env.VIDEOS_PREMIUM_PLAN_ID;

    if (!planId) {
      console.log('📋 Creando plan de Videos Premium...');
      const newPlan = await culqiRequest('/recurrent/plans/create', 'POST', {
        name: 'Videos Premium Palmeritos',
        short_name: 'videos-premium-mensual',
        description: 'Acceso ilimitado a videos exclusivos',
        amount: 999, // S/ 9.99
        currency: 'PEN',
        interval_unit_time: 3, // Mensual
        interval_count: 0,
        initial_cycles: {
          count: 0,
          has_initial_charge: true,
          amount: 999,
          interval_unit_time: 3
        }
      });
      planId = newPlan.id;
      process.env.VIDEOS_PREMIUM_PLAN_ID = planId;
      console.log('✅ Plan creado:', planId);
    }

    // Paso 4: Crear suscripción
    const subscription = await culqiRequest('/recurrent/subscriptions/create', 'POST', {
      card_id: card.id,
      plan_id: planId,
      tyc: true,
      metadata: { user_email: email, service: 'videos_premium' }
    });

    console.log('✅ Suscripción creada:', subscription.id);

    // Paso 5: Actualizar PocketBase
    await updatePocketBaseUser(email, {
      subscription_active: true,
      subscription_id: subscription.id,
      subscription_start: new Date().toISOString(),
      culqi_customer_id: customer.id
    });

    res.json({
      success: true,
      subscription_id: subscription.id,
      customer_id: customer.id,
      message: 'Suscripción activa. Ya tienes acceso a los videos premium.'
    });

  } catch (error) {
    console.error('❌ Error en suscripción:', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.merchant_message || error.user_message || 'Error creando la suscripción',
      code: error.code || 'UNKNOWN_ERROR'
    });
  }
});

// ==========================================
// ENDPOINT: Cancelar suscripción
// ==========================================
app.post('/api/subscription/cancel', async (req, res) => {
  try {
    const { subscription_id, email } = req.body;

    if (!subscription_id) {
      return res.status(400).json({ success: false, error: 'Se requiere subscription_id' });
    }

    await culqiRequest(`/recurrent/subscriptions/${subscription_id}/cancel`, 'DELETE');

    if (email) {
      await updatePocketBaseUser(email, {
        subscription_active: false,
        subscription_cancelled_at: new Date().toISOString()
      });
    }

    console.log('✅ Suscripción cancelada:', subscription_id);

    res.json({ success: true, message: 'Suscripción cancelada' });

  } catch (error) {
    console.error('❌ Error cancelando:', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.merchant_message || 'Error cancelando la suscripción'
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║   PALMERITOS - SERVIDOR DE PAGOS CULQI         ║
╠════════════════════════════════════════════════╣
║  🌐 http://localhost:${PORT}                     ║
║                                                ║
║  Endpoints:                                    ║
║  POST /api/charge        → Pago único          ║
║  POST /api/subscription  → Suscripción         ║
║  POST /api/subscription/cancel → Cancelar      ║
║  GET  /api/health        → Estado del servidor ║
╚════════════════════════════════════════════════╝
  `);
});
