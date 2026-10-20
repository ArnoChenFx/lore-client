//! Explicit request ownership enters a thread-local scope only inside a blocking task.
//! Lore callbacks capture a copy before entering Lore's runtime and never read this scope.

use super::*;
use std::cell::RefCell;
use std::marker::PhantomData;
use std::rc::Rc;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationContext {
    pub request_id: String,
    #[serde(deserialize_with = "required_workspace_key")]
    pub workspace_key: Option<String>,
}

// The field is required on the wire even when this request belongs to the device.
fn required_workspace_key<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

impl OperationContext {
    pub(super) fn validate(&self) -> Result<(), LoreCommandError> {
        if self.request_id.is_empty()
            || self.request_id.len() > 128
            || !self
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(LoreCommandError::new(
                "operation_request_id_invalid",
                "The operation request ID must contain 1–128 ASCII letters, digits, '-' or '_'",
            ));
        }
        Ok(())
    }

    pub(super) fn validate_workspace(self) -> Result<Self, LoreCommandError> {
        if let Some(path) = self.workspace_key.as_deref() {
            let canonical = validate_existing_directory(path, "Operation workspace")?;
            if path != display_path_without_windows_verbatim_prefix(&canonical) {
                return Err(LoreCommandError::new(
                    "operation_workspace_not_canonical",
                    "The operation workspace must use the canonical directory returned when opening it",
                ));
            }
        }
        Ok(self)
    }
}

thread_local! {
    static CURRENT_OPERATION_CONTEXT: RefCell<Option<OperationContext>> = const { RefCell::new(None) };
}

/// This guard must stay on the blocking thread where it was installed.
pub(super) struct OperationContextScope {
    previous: Option<OperationContext>,
    _thread_bound: PhantomData<Rc<()>>,
}

impl OperationContextScope {
    pub(super) fn enter(context: OperationContext) -> Self {
        let previous = CURRENT_OPERATION_CONTEXT.with(|current| current.replace(Some(context)));
        Self {
            previous,
            _thread_bound: PhantomData,
        }
    }
}

impl Drop for OperationContextScope {
    fn drop(&mut self) {
        CURRENT_OPERATION_CONTEXT.with(|current| current.replace(self.previous.take()));
    }
}

pub(super) fn current_operation_context() -> Result<OperationContext, LoreCommandError> {
    CURRENT_OPERATION_CONTEXT.with(|current| {
        current.borrow().clone().ok_or_else(|| {
            LoreCommandError::new(
                "operation_context_missing",
                "The Lore operation must run inside an explicit request scope",
            )
        })
    })
}

#[cfg(test)]
pub(super) fn test_operation_context() -> OperationContext {
    static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
    OperationContext {
        request_id: format!(
            "test-request-{}",
            NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)
        ),
        workspace_key: None,
    }
}

#[cfg(test)]
pub(super) fn test_operation_scope() -> OperationContextScope {
    OperationContextScope::enter(test_operation_context())
}
