pub mod app_error;
pub use app_error::AppError;
// 仅测试目标使用 (tunnel_service 测试断言 DTO 映射); 非 test 构建下不导出避免 unused 警告
#[cfg(test)]
pub use app_error::AppErrorDto;
