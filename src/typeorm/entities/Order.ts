// src/entity/Order.ts
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, ManyToMany, JoinTable, type Relation } from "typeorm";
import { Customer } from "./Customer";
import { Product } from "./Product";

@Entity("Order")
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  // sqlite
  // @Column({ type: 'datetime' })
  // postgres
  @Column({ type: "timestamptz" })
  date: Date;

  @Column({ name: "totalAmount", type: "decimal" })
  totalAmount: number;

  @ManyToOne(() => Customer, (customer) => customer.orders, { onDelete: "CASCADE", onUpdate: "CASCADE" })
  // Relation<> keeps the decorator metadata from reading Customer before it exists (circular import).
  customer: Relation<Customer>;

  @ManyToMany(() => Product)
  @JoinTable({
    name: "_OrderProducts",
    joinColumn: { name: "A", referencedColumnName: "id" },
    inverseJoinColumn: { name: "B", referencedColumnName: "id" },
  })
  products: Product[];
}
