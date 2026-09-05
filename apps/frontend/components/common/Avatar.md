# Avatar Component

Component hiển thị avatar nhân viên với fallback thông minh.

## Tính năng

### 1. **Hiển thị ảnh avatar**
- Nếu có `src` → hiển thị ảnh
- Tự động thêm API URL nếu là relative path
- Xử lý lỗi load ảnh tự động

### 2. **Fallback thông minh**
- **Có tên nhưng không có ảnh** → Hiển thị chữ cái đầu (initials)
  - VD: "Nguyễn Văn An" → "NA"
  - Màu background được tạo tự động dựa trên tên (consistent color)
- **Không có tên và ảnh** → Hiển thị icon user mặc định

### 3. **Responsive sizes**
- `xs`: 24x24px (text: xs)
- `sm`: 32x32px (text: sm)
- `md`: 40x40px (text: base) - **Default**
- `lg`: 48x48px (text: lg)
- `xl`: 64x64px (text: 2xl)

## Cách sử dụng

### Import
```tsx
import Avatar from '@/components/common/Avatar';
```

### Basic Usage

#### 1. Avatar với ảnh
```tsx
<Avatar 
  src="/uploads/avatars/user123.jpg"
  name="Nguyễn Văn An"
  size="md"
  alt="User avatar"
/>
```

#### 2. Avatar chỉ có tên (hiển thị initials)
```tsx
<Avatar 
  name="Trần Thị Bình"
  size="lg"
/>
```

#### 3. Avatar không có thông tin (icon mặc định)
```tsx
<Avatar size="sm" />
```

### Advanced Usage

#### Với API URL từ backend
```tsx
<Avatar 
  src={employee.avatarUrl}  // e.g., "/uploads/avatars/emp001.jpg"
  name={employee.fullName}
  size="md"
/>
```
→ Component tự động thêm `NEXT_PUBLIC_API_URL` nếu là relative path

#### Với external URL
```tsx
<Avatar 
  src="https://example.com/avatar.jpg"
  name="External User"
  size="lg"
/>
```

#### Custom className
```tsx
<Avatar 
  src={user.avatarUrl}
  name={user.name}
  size="xl"
  className="border-4 border-blue-500"
/>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `src` | `string \| null` | `undefined` | URL của ảnh avatar (absolute hoặc relative) |
| `name` | `string` | `undefined` | Tên đầy đủ để generate initials |
| `size` | `'xs' \| 'sm' \| 'md' \| 'lg' \| 'xl'` | `'md'` | Kích thước avatar |
| `className` | `string` | `''` | Custom Tailwind classes |
| `alt` | `string` | Auto-generated | Alt text cho img tag |

## Logic Flow

```
1. Kiểm tra src
   ├─ Có src?
   │  ├─ Yes → Hiển thị <img>
   │  │         └─ onError → Fallback to initials/icon
   │  └─ No → Tiếp tục
   │
2. Kiểm tra name
   ├─ Có name?
   │  ├─ Yes → Hiển thị initials
   │  │         └─ Background color từ hash(name)
   │  └─ No → Hiển thị icon User
```

## Color Generation

Màu background cho initials được tạo dựa trên:
- **Hash của tên** → Đảm bảo cùng tên = cùng màu
- **10 màu palette**: blue, green, purple, pink, indigo, red, yellow, cyan, teal, orange

## Ví dụ thực tế

### TopHeader.tsx
```tsx
<Avatar
  src={user?.employee?.avatarUrl}
  name={displayName}
  size="md"
  alt={displayName}
/>
```

### Employee List
```tsx
{employees.map(emp => (
  <div key={emp.id} className="flex items-center gap-3">
    <Avatar
      src={emp.avatarUrl}
      name={emp.fullName}
      size="sm"
    />
    <span>{emp.fullName}</span>
  </div>
))}
```

### Profile Page
```tsx
<div className="w-24 h-24 rounded-2xl border-4 border-white shadow-lg overflow-hidden">
  <Avatar
    src={employee.avatarUrl}
    name={employee.fullName}
    size="xl"
    className="rounded-none!"
  />
</div>
```

## Updated Files

Following files đã được update để sử dụng Avatar component:

1. ✅ `components/dashboard/TopHeader.tsx`
2. ✅ `app/dashboard/attendance/face-management/page.tsx` (2 chỗ)
3. ✅ `app/dashboard/profile/page.tsx`

## Benefits

1. **DRY (Don't Repeat Yourself)**: Tái sử dụng logic ở nhiều nơi
2. **Consistent UI**: Avatar hiển thị đồng nhất trong toàn hệ thống
3. **Error Handling**: Tự động xử lý lỗi load ảnh
4. **Accessibility**: Có alt text cho screen readers
5. **Performance**: Lazy loading và onError handling
6. **Customizable**: Dễ dàng thay đổi size, colors, styles

## Future Enhancements

- [ ] Lazy loading cho ảnh
- [ ] Placeholder skeleton khi đang load
- [ ] Upload avatar trực tiếp từ component
- [ ] Crop/resize ảnh trước khi upload
- [ ] Badge/indicator (online/offline status)
