const { getCosmosClient, getUserId } = require('../shared/cosmos');

module.exports = async function (context, req) {
  const userId = await getUserId(req);
  if (!userId) {
    context.res = { status: 401, body: { error: 'Not authenticated' } };
    return;
  }

  const db = getCosmosClient();
  const container = db.container('projects');
  const method = req.method.toUpperCase();
  const projectId = context.bindingData.id;

  try {
    switch (method) {
      case 'GET': {
        const { resources } = await container.items
          .query({
            query: 'SELECT * FROM c WHERE c.userId = @userId ORDER BY c.name ASC',
            parameters: [{ name: '@userId', value: userId }]
          })
          .fetchAll();

        context.res = { status: 200, body: resources };
        break;
      }

      case 'POST': {
        const body = req.body;
        const item = {
          id: body.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          userId,
          name: body.name || 'Untitled Project',
          color: body.color || '#4c6ef5'
        };

        const { resource } = await container.items.create(item);
        context.res = { status: 201, body: resource };
        break;
      }

      case 'PUT': {
        if (!projectId) {
          context.res = { status: 400, body: { error: 'Project ID required' } };
          return;
        }

        const { resource: existing } = await container.item(projectId, userId).read();
        if (!existing || existing.userId !== userId) {
          context.res = { status: 404, body: { error: 'Not found' } };
          return;
        }

        const updates = req.body;
        const updated = {
          ...existing,
          name: updates.name ?? existing.name,
          color: updates.color ?? existing.color
        };

        const { resource } = await container.item(projectId, userId).replace(updated);
        context.res = { status: 200, body: resource };
        break;
      }

      case 'DELETE': {
        if (!projectId) {
          context.res = { status: 400, body: { error: 'Project ID required' } };
          return;
        }
        await container.item(projectId, userId).delete();
        context.res = { status: 204 };
        break;
      }

      default:
        context.res = { status: 405, body: { error: 'Method not allowed' } };
    }
  } catch (err) {
    context.log.error('Projects API error:', err.message);
    const status = err.code === 404 ? 404 : 500;
    context.res = { status, body: { error: err.message } };
  }
};
