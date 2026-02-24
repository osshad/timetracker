const { getCosmosClient, getUserId } = require('../shared/cosmos');

/**
 * Timer State API — stores/retrieves the active running timer in Cosmos DB.
 * Uses a single document per user with id = "active-timer" in the entries container.
 *
 * GET  /api/timer-state         → returns active timer or { running: false }
 * PUT  /api/timer-state         → save/update active timer state
 * DELETE /api/timer-state       → clear active timer (timer stopped)
 */
module.exports = async function (context, req) {
  const userId = await getUserId(req);
  if (!userId) {
    context.res = { status: 401, body: { error: 'Not authenticated' } };
    return;
  }

  const db = getCosmosClient();
  const container = db.container('entries');
  const timerId = 'active-timer';
  const method = req.method.toUpperCase();

  try {
    switch (method) {
      case 'GET': {
        try {
          const { resource } = await container.item(timerId, userId).read();
          if (resource && resource.running) {
            context.res = { status: 200, body: resource };
          } else {
            context.res = { status: 200, body: { running: false } };
          }
        } catch (err) {
          if (err.code === 404) {
            context.res = { status: 200, body: { running: false } };
          } else {
            throw err;
          }
        }
        return;
      }

      case 'PUT': {
        const body = req.body;
        const timerDoc = {
          id: timerId,
          userId,
          running: true,
          start: body.start,
          desc: body.desc || '',
          projectId: body.projectId || '',
          deviceId: body.deviceId || 'unknown',
          updatedAt: new Date().toISOString()
        };

        try {
          await container.item(timerId, userId).read();
          // Exists — replace
          const { resource } = await container.item(timerId, userId).replace(timerDoc);
          context.res = { status: 200, body: resource };
        } catch (err) {
          if (err.code === 404) {
            // Doesn't exist — create
            const { resource } = await container.items.create(timerDoc);
            context.res = { status: 201, body: resource };
          } else {
            throw err;
          }
        }
        return;
      }

      case 'DELETE': {
        try {
          await container.item(timerId, userId).delete();
        } catch (err) {
          if (err.code !== 404) throw err;
        }
        context.res = { status: 204 };
        return;
      }

      default:
        context.res = { status: 405, body: { error: 'Method not allowed' } };
    }
  } catch (err) {
    context.log.error('Timer state API error:', err.message, err.stack);
    context.res = { status: 500, body: { error: err.message } };
  }
};
