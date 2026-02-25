export function JobTable(): React.JSX.Element {
  // TODO: fetch from API with pagination
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-800 bg-gray-900 text-xs text-gray-400">
          <tr>
            <th className="px-4 py-3">Job ID</th>
            <th className="px-4 py-3">Agent</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Created</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody className="text-gray-300">
          <tr>
            <td className="px-4 py-6 text-center text-gray-500" colSpan={5}>
              No jobs found.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
