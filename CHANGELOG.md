# Changelog

## [0.1.0] - 2026-02-11

### Added
- **Preview Pane**: integrated preview sidebar for viewing images and text/code files directly within the application.
- **File & Folder Operations**:
    - Added ability to **Move** files and folders via context menu and drag & drop.
    - Added ability to **Rename** files and folders via context menu.
- **Drag & Drop Improvements**:
    - Support for moving files into folders by dragging/dropping rows.
    - Recursive directory uploading when dragging folders from the OS explorer.
- **UI UX**:
    - Added blocking loading overlay for long-running operations (auth, move, delete).
    - Added "Credits" section to README.
- **Backend**:
    - Implemented secure `get_presigned_url` for image previews.
    - Implemented `read_text_file` with size limits.
    - Implemented `copy_object` and `rename_folder` (Copy+Delete) primitives in Rust.

### Fixed
- Fixed build issues related to unused imports.
- Fixed folder renaming to handle trailing slashes correctly.
