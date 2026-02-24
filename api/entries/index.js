const { getCosmosClient, getUserId } = require('../shared/cosmos');

module.exports = async function (context, req) {
  const userId = await getUserId(req);
  if (!userId) {
    context.res = { status: 401, body: { error: 'Not authenticated' } };
    return;
  }

  const db = getCosmosClient();
  const container = db.container('entries');
  const method = req.method.toUpperCase();
  const entryId = context.bindingData.id;

  try {
    switch (method) {
      case 'GET': {
        // GET /api/entries?date=YYYY-MM-DD  — entries for a specific date
        // GET /api/entries?from=YYYY-MM-DD&to=YYYY-MM-DD — entries in range
        const { date, from, to } = req.query;
        let query;
        let params;

        if (date) {
          query = 'SELECT * FROM c WHERE c.userId = @userId AND c.date = @date';
          params = [
            { name: '@userId', value: userId },
            { name: '@date', value: date }
          ];
        } else if (from && to) {
          query = 'SELECT * FROM c WHERE c.userId = @userId AND c.date >= @from AND c.date <= @to';
          params = [
            { name: '@userId', value: userId },
            { name: '@from', value: from },
            { name: '@to', value: to }
          ];
        } else {
          query = 'SELECT * FROM c WHERE c.userId = @userId';
          params = [{ name: '@userId', value: userId }];
        }

        const { resources } = await container.items
          .query({ query, parameters: params })
          .fetchAll();

        // Sort client-side: newest date first, then newest start first
        resources.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.start || '').localeCompare(a.start || ''));

        context.res = { status: 200, body: resources };
        break;
      }

      case 'POST': {
        const body = req.body;
        const item = {
          id: body.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          userId,
          desc: body.desc || 'Untitled',
          projectId: body.projectId || '',
          start: body.start,
          end: body.end,
          date: body.date,
          duration: body.duration
        };

        const { resource } = await container.items.create(item);
        context.res = { status: 201, body: resource };
        break;
      }

      case 'PUT': {
        if (!entryId) {
          context.res = { status: 400, body: { error: 'Entry ID required' } };
          return;
        }

        // Read existing to verify ownership
        const { resource: existing } = await container.item(entryId, userId).read();
        if (!existing || existing.userId !== userId) {
          context.res = { status: 404, body: { error: 'Not found' } };
          return;
        }

        const updates = req.body;
        const updated = {
          ...existing,
          desc: updates.desc ?? existing.desc,
          projectId: updates.projectId ?? existing.projectId,
          start: updates.start ?? existing.start,
          end: updates.end ?? existing.end,
          date: updates.date ?? existing.date,
          duration: updates.duration ?? existing.duration
        };

        const { resource } = await container.item(entryId, userId).replace(updated);
        context.res = { status: 200, body: resource };
        break;
      }

      case 'DELETE': {
        if (!entryId) {
          context.res = { status: 400, body: { error: 'Entry ID required' } };
          return;
        }
        await container.item(entryId, userId).delete();
        context.res = { status: 204 };
        break;
      }

      default:
        context.res = { status: 405, body: { error: 'Method not allowed' } };
    }
  } catch (err) {
    context.log.error('Entries API error:', err.message, err.stack);
    const status = err.code === 404 ? 404 : 500;
    context.res = { status, body: { error: err.message } };
  }
};
