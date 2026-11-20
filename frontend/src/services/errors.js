export function apiErrorMessage(error) {
  return error.response?.data?.error || error.message || 'Something went wrong.';
}
